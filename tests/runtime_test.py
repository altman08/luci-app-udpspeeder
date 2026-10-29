"""Run the shipped shell code with temporary paths and a minimal UCI adapter."""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'luci-app-udpspeeder/root/usr/share/udpspeeder-luci'


def config_adapter(rules):
    cases = []
    for sid, values in rules.items():
        for name, value in values.items():
            cases.append(f'{shlex.quote(sid + ":" + name)}) _cg_value={shlex.quote(str(value))} ;;')
    return '''config_load() { :; }
config_get() {
    local _cg_value="$4"
    case "$2:$3" in
''' + '\n'.join(cases) + '''
    esac
    export "$1=$_cg_value"
}
config_get_bool() { config_get "$@"; }
'''


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.common = self.work / 'common.sh'
        self.common.write_text((RUNTIME / 'common.sh').read_text().replace(
            'STATE_DIR=/var/run/udpspeeder-luci', 'STATE_DIR=' + shlex.quote(str(self.work))))
        self.rule = {'TYPE': 'udpspeeder', 'local': '127.0.0.1:9000', 'remote': '127.0.0.1:9001',
                     'key': 'test-secret', 'enabled': '1'}

    def shell(self, code, rule=None):
        prelude = f'. {shlex.quote(str(self.common))}\n' + config_adapter({'r1': rule or self.rule})
        return subprocess.run(['sh', '-c', prelude + code], universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)

    def test_validation_rejects_invalid_settings_before_launch(self):
        for field, value in [('fec', '1:255'), ('fec', '2:1,1:1'), ('mode', '2'), ('mtu', '99'),
                             ('timeout', '1001'), ('decode_buf', '299'), ('report', '-1'),
                             ('key', 'contains space'), ('local', 'host.example:9000'),
                             ('remote', '$(touch hacked):1234'), ('jitter', '10:1')]:
            with self.subTest(field=field, value=value):
                result = self.shell('load_rule r1 && validate_rule', dict(self.rule, **{field: value}))
                self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse((self.work / 'hacked').exists())

    def test_valid_legacy_config_ipv6_and_boundary_fec(self):
        result = self.shell('load_rule r1 && validate_rule && printf "%s|%s|%s" "$local_endpoint" "$remote_host" "$remote_port"',
                            dict(self.rule, local='[::1]:9000', remote='[2001:db8::1]:9001', fec='255:0'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '[::1]:9000|2001:db8::1|9001')

    def test_dns_auto_prefers_ipv4_and_falls_back_to_aaaa_and_system(self):
        result = self.shell('''
timeout() { shift; "$@"; }
nslookup() {
    printf '%s\\n' "$*" >> "$STATE_DIR/queries"
    case "$*" in
        *broken) return 1 ;;
        -type=AAAA*) printf 'Server: 127.0.0.1\\nAddress: 127.0.0.1#53\\n\\nName: peer.example\\nAddress: 2001:db8::9\\n' ;;
    esac
}
resolve_host peer.example auto broken
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '2001:db8::9')
        self.assertEqual((self.work / 'queries').read_text().splitlines(), [
            '-type=A peer.example broken', '-type=AAAA peer.example broken', '-type=A peer.example', '-type=AAAA peer.example'])

    def test_nslookup_excludes_resolver_address_and_respects_family(self):
        outputs = [
            ('Server: 192.0.2.53\nAddress: 192.0.2.53#53\n\nName: peer.example\nAddress: 198.51.100.8\nAddress: 2001:db8::8\n', '198.51.100.8', '2001:db8::8'),
            ('Server: dns\nAddress 1: 2001:db8::53 dns\n\nName: peer.example\nAddress 1: 2001:db8::9 peer.example\nAddress 2: 198.51.100.9 peer.example\n', '198.51.100.9', '2001:db8::9')]
        for output, ipv4, ipv6 in outputs:
            for family, expected in [('auto', ipv4), ('ipv4', ipv4), ('ipv6', ipv6)]:
                with self.subTest(family=family, output=output):
                    mock = 'timeout() { shift; "$@"; }\nnslookup() { printf "%s" ' + shlex.quote(output) + '; }\n'
                    result = self.shell(mock + 'resolve_host peer.example ' + family + " ''")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), expected)
        failure = 'Server: 192.0.2.53\nAddress: 192.0.2.53#53\n** server cannot find peer.example: NXDOMAIN\n'
        result = self.shell('timeout() { shift; "$@"; }\nnslookup() { printf "%s" ' + shlex.quote(failure) + '; }\n' +
                            "resolve_host peer.example auto ''")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')

    def runner(self, binary=None, rule=None):
        adapter = self.work / 'functions.sh'
        adapter.write_text(config_adapter({'r1': rule or self.rule}))
        if binary is None:
            binary = self.work / 'fake-core'
            binary.write_text('''#!/usr/bin/env python3
import json, os, signal, sys, time
from pathlib import Path
Path(os.environ['TEST_ARGS']).write_text(json.dumps({'argv': sys.argv[1:], 'pid': os.getpid()}))
print('argc=5 -k test-secret', flush=True)
print('[debug]key=test-secret', flush=True)
for i in range(15): print('normal event %s' % i, flush=True)
if os.environ.get('TEST_WAIT'):
    while True: signal.pause()
''')
            binary.chmod(0o755)
        runner = self.work / 'run.sh'
        runner.write_text((RUNTIME / 'run.sh').read_text()
                          .replace('/lib/functions.sh', str(adapter))
                          .replace('/usr/share/udpspeeder-luci/common.sh', str(self.common))
                          .replace('/usr/bin/udpspeeder', str(binary)))
        return runner

    def test_runner_omits_report_zero_bounds_logs_and_hides_key(self):
        # Add globals to the adapter used by the actual runner.
        runner = self.runner(rule=dict(self.rule, report='0', fec='1:2,20:10'))
        (self.work / 'functions.sh').write_text(config_adapter({
            'r1': dict(self.rule, report='0', fec='1:2,20:10'), 'global': {'log_max': '10'}}))
        result = subprocess.run(['sh', str(runner), 'r1'], env=dict(os.environ, TEST_ARGS=str(self.work / 'args')),
                                universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads((self.work / 'args').read_text())['argv']
        self.assertNotIn('--report', args)
        self.assertEqual(args[args.index('--fec') + 1], '1:2,20:10')
        log = (self.work / 'r1.log').read_text()
        self.assertNotIn('test-secret', log)
        self.assertEqual(log.splitlines(), [f'normal event {i}' for i in range(5, 15)])
        self.assertFalse((self.work / 'r1.pipe').exists())

    def test_terminating_wrapper_reaps_its_core_process(self):
        runner = self.runner()
        process = subprocess.Popen(['sh', str(runner), 'r1'], env=dict(os.environ,
            TEST_ARGS=str(self.work / 'args'), TEST_WAIT='1'), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                if (self.work / 'args').exists(): break
                time.sleep(0.02)
            child = json.loads((self.work / 'args').read_text())['pid']
            process.terminate()
            process.wait(timeout=5)
            with self.assertRaises(ProcessLookupError): os.kill(child, 0)
            self.assertFalse((self.work / 'r1.pipe').exists())
        finally:
            if process.poll() is None: process.kill(); process.wait()
            process.stderr.close()

    def test_single_rule_start_passes_section_to_procd_add_path(self):
        init = ROOT / 'luci-app-udpspeeder/root/etc/init.d/udpspeeder-luci'
        source = init.read_text().replace('. /usr/share/udpspeeder-luci/common.sh', '. ' + shlex.quote(str(self.common)))
        result = self.shell(source + '''
uci() { case "$*" in '-q get udpspeeder.r1') echo udpspeeder ;; esac; }
start() { printf 'start:%s\\n' "$1"; }
stop() { printf 'stop:%s\\n' "$1"; }
rule_start r1
rule_stop r1
rule_start '../invalid'
''')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout.splitlines(), ['start:r1', 'stop:r1'])

    def test_dns_monitor_restarts_only_changed_enabled_domain_without_preseeding(self):
        source = (RUNTIME / 'monitor.sh').read_text().split('while :; do')[0]
        source = source.replace('. /lib/functions.sh', '').replace(
            '. /usr/share/udpspeeder-luci/common.sh', '. ' + shlex.quote(str(self.common)))
        control = self.work / 'control'
        control.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> ' + shlex.quote(str(self.work / 'actions')) + '\n')
        control.chmod(0o755)
        source = source.replace('/etc/init.d/udpspeeder-luci', str(control))
        rules = {
            'changed': {'enabled': '1', 'remote': 'changed.example:9000'},
            'same': {'enabled': '1', 'remote': 'same.example:9000'},
            'disabled': {'enabled': '0', 'remote': 'changed.example:9000'},
            'literal': {'enabled': '1', 'remote': '192.0.2.1:9000'}}
        (self.work / 'changed.resolved').write_text('192.0.2.1\n')
        (self.work / 'same.resolved').write_text('192.0.2.2\n')
        result = self.shell(source + config_adapter(rules) + '''
resolve_host() { echo 192.0.2.2; }
check_domain changed
check_domain same
check_domain disabled
check_domain literal
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.work / 'actions').read_text(), 'refresh_rule changed\n')
        self.assertEqual((self.work / 'changed.resolved').read_text(), '192.0.2.1\n')

    def test_install_upgrade_and_removal_preserve_legacy_autostart_state(self):
        for initially_enabled in [True, False]:
            with self.subTest(initially_enabled=initially_enabled), tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                state = work / 'enabled'
                if initially_enabled: state.touch()
                calls = work / 'calls'
                old = work / 'udpspeeder'
                old.write_text('''#!/bin/sh
echo "$1" >> ''' + shlex.quote(str(calls)) + '''
case "$1" in
    enabled) test -f ''' + shlex.quote(str(state)) + ''' ;;
    enable) touch ''' + shlex.quote(str(state)) + ''' ;;
    disable) rm -f ''' + shlex.quote(str(state)) + ''' ;;
esac
''')
                old.chmod(0o755)
                new = work / 'udpspeeder-luci'
                new.write_text('#!/bin/sh\nexit 0\n'); new.chmod(0o755)
                common = work / 'common.sh'
                common.write_text((RUNTIME / 'common.sh').read_text().replace('/etc/init.d/', str(work) + '/'))
                tools = work / 'tools'; tools.mkdir()
                ubus = tools / 'ubus'
                ubus.write_text('#!/bin/sh\necho \'{"udpspeeder":{"instances":{}}}\'\n')
                ubus.chmod(0o755)
                lifecycle = work / 'lifecycle.sh'
                lifecycle.write_text((RUNTIME / 'lifecycle.sh').read_text()
                    .replace('/usr/share/udpspeeder-luci/common.sh', str(common))
                    .replace('/etc/udpspeeder-luci', str(work / 'marker'))
                    .replace('/etc/init.d/udpspeeder', str(old))
                    .replace('/etc/init.d/rpcd reload', 'true')
                    .replace('/tmp/luci-indexcache.*', str(work / 'cache'))
                    .replace('uci -q ', 'true -q ')
                    .replace('uci set ', 'true set ')
                    .replace('uci commit ', 'true commit '))
                for action in ['install', 'install', 'remove']:
                    result = subprocess.run(['sh', str(lifecycle), action], env=dict(os.environ, PATH=str(tools) + ':' + os.environ['PATH']), stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, universal_newlines=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    if action == 'install': self.assertFalse(state.exists())
                self.assertEqual(state.exists(), initially_enabled)
                self.assertEqual(calls.read_text().splitlines().count('enabled'), 1)

    def test_absent_service_is_not_stopped_and_bus_failures_are_reported(self):
        common = self.work / 'service-common.sh'
        calls = self.work / 'stops'
        common.write_text(self.common.read_text().replace('/etc/init.d/', str(self.work) + '/'))
        service = self.work / 'udpspeeder-luci'
        service.write_text('#!/bin/sh\necho "$*" >> ' + shlex.quote(str(calls)) + '\n')
        service.chmod(0o755)
        prelude = '. ' + shlex.quote(str(common)) + '\n'
        for info, expected in [('{}', False), ('{"udpspeeder-luci":{"instances":{}}}', True)]:
            code = prelude + 'ubus() { printf "%s" ' + shlex.quote(info) + '; }\nstop_if_registered udpspeeder-luci'
            result = subprocess.run(['sh', '-c', code], env=dict(os.environ, LC_ALL='C', LANG='C'), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, b'')
            self.assertEqual(calls.exists(), expected)
        calls.unlink()
        result = subprocess.run(['sh', '-c', prelude + 'ubus() { echo "bus unavailable" >&2; return 1; }\nstop_if_registered udpspeeder-luci'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'bus unavailable', result.stderr)
        self.assertFalse(calls.exists())


if __name__ == '__main__':
    unittest.main()
