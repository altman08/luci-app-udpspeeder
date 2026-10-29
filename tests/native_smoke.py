#!/usr/bin/env python3
"""Optional real-core UDP roundtrip: python3 tests/native_smoke.py /path/to/udpspeeder."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading

from runtime_test import RuntimeTests, config_adapter, RUNTIME


def free_port(family, host):
    sock = socket.socket(family, socket.SOCK_DGRAM)
    try:
        sock.bind((host, 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


def roundtrip(binary, family, host, mode):
    case = RuntimeTests()
    case.setUp()
    echo = socket.socket(family, socket.SOCK_DGRAM)
    echo.bind((host, 0))
    echo.settimeout(0.2)
    done = threading.Event()

    def reflect():
        while not done.is_set():
            try:
                data, peer = echo.recvfrom(65535)
                echo.sendto(data, peer)
            except socket.timeout:
                pass

    thread = threading.Thread(target=reflect)
    thread.start()
    processes = []
    try:
        server_port = free_port(family, host)
        client_port = free_port(family, host)

        def endpoint(port):
            return ('[%s]:%s' if family == socket.AF_INET6 else '%s:%s') % (host, port)

        rules = {
            'server1': dict(case.rule, server='1', local=endpoint(server_port),
                            remote=endpoint(echo.getsockname()[1]), mode=str(mode), fec='20:10'),
            'client1': dict(case.rule, server='0', local=endpoint(client_port),
                            remote=endpoint(server_port), mode=str(mode), fec='20:10')}
        adapter = case.work / 'functions.sh'
        adapter.write_text(config_adapter(rules))
        runner = case.work / 'run.sh'
        runner.write_text((RUNTIME / 'run.sh').read_text()
                          .replace('/lib/functions.sh', str(adapter))
                          .replace('/usr/share/udpspeeder-luci/common.sh', str(case.common))
                          .replace('/usr/bin/udpspeeder', str(binary)))
        for sid in rules:
            processes.append(subprocess.Popen(['sh', str(runner), sid], stdout=subprocess.DEVNULL,
                                               stderr=subprocess.PIPE))
        client = socket.socket(family, socket.SOCK_DGRAM)
        client.settimeout(0.3)
        try:
            for size in ([32, 1200, 3000] if mode == 0 else [32, 1000]):
                payload = os.urandom(size)
                for attempt in range(12):
                    client.sendto(payload, (host, client_port))
                    try:
                        result = client.recv(65535)
                        break
                    except socket.timeout:
                        pass
                else:
                    logs = '\n'.join(p.read_text() for p in case.work.glob('*.log'))
                    raise AssertionError('No response: family=%s mode=%s size=%s\n%s' % (family, mode, size, logs))
                assert result == payload
        finally:
            client.close()
        for logfile in case.work.glob('*.log'):
            assert 'test-secret' not in logfile.read_text()
        print('PASS native UDP roundtrip: family=%s FEC mode=%s' % (family, mode))
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            process.wait(timeout=5)
            process.stderr.close()
        done.set()
        thread.join(timeout=2)
        echo.close()
        case.doCleanups()


if __name__ == '__main__':
    binary = Path(sys.argv[1]).resolve()
    for family, host in [(socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')]:
        for mode in [0, 1]:
            roundtrip(binary, family, host, mode)
