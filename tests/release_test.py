"""Exercise the release collection script with SDK-style package filenames."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
BASH = shutil.which('bash')


@unittest.skipUnless(BASH, 'Bash is required for release collection')
class ReleaseTests(unittest.TestCase):
    def collection_script(self):
        workflow = (ROOT / '.github/workflows/release-openwrt.yml').read_text(encoding='utf-8')
        step = workflow.split('      - name: Collect frontend and Chinese translation\n', 1)[1]
        return textwrap.dedent(step.split('        run: |\n', 1)[1].split('      - name:', 1)[0])

    def filenames(self, fmt):
        if fmt == 'ipk':
            return ['luci-app-udpspeeder_1.0.0-r6_all.ipk',
                    'luci-i18n-udpspeeder-zh-cn_1.0.0-r6_all.ipk']
        return ['luci-app-udpspeeder-1.0.0-r6.apk',
                'luci-i18n-udpspeeder-zh-cn-1.0.0-r6.apk']

    def run_collection(self, directory, fmt, sdk):
        return subprocess.run([BASH, '-c', self.collection_script()], cwd=str(directory),
                              env=dict(os.environ, FORMAT=fmt, SDK=sdk),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_both_formats_include_main_translation_and_valid_checksums(self):
        for fmt, sdk in [('ipk', '24.10.5'), ('apk', '25.12.5')]:
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as directory:
                package_dir = Path(directory) / 'bin/packages/x86_64/action'
                package_dir.mkdir(parents=True)
                # Include dependencies and the other format to ensure they are excluded.
                for filename in self.filenames('ipk') + self.filenames('apk') + ['UDPspeeder-20230206-r6.apk']:
                    (package_dir / filename).write_bytes(filename.encode())
                result = self.run_collection(directory, fmt, sdk)
                self.assertEqual(result.returncode, 0, result.stderr)
                release = Path(directory) / 'release'
                expected = {}
                for filename in self.filenames(fmt):
                    stem, ext = filename.rsplit('.', 1)
                    expected[stem + '_openwrt-' + sdk + '.' + ext] = filename.encode()
                sums = 'sha256sums_openwrt-' + sdk + '_' + fmt
                self.assertEqual({p.name for p in release.iterdir()}, set(expected) | {sums})
                self.assertEqual(len((release / sums).read_text().splitlines()), 2)
                for line in (release / sums).read_text().splitlines():
                    digest, filename = line.split(None, 1)
                    self.assertEqual((release / filename).read_bytes(), expected[filename])
                    self.assertEqual(digest, hashlib.sha256(expected[filename]).hexdigest())

    def test_missing_main_or_translation_prevents_publication(self):
        for fmt, sdk in [('ipk', '24.10.5'), ('apk', '25.12.5')]:
            for missing in self.filenames(fmt):
                with self.subTest(fmt=fmt, missing=missing), tempfile.TemporaryDirectory() as directory:
                    package_dir = Path(directory) / 'bin/packages/x86_64/action'
                    package_dir.mkdir(parents=True)
                    for filename in self.filenames(fmt):
                        if filename != missing:
                            (package_dir / filename).write_bytes(b'package')
                    result = self.run_collection(directory, fmt, sdk)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(b'::error::Expected', result.stdout)
                    self.assertFalse((Path(directory) / 'release').exists())

    def test_other_package_format_cannot_satisfy_a_build(self):
        for fmt, other in [('ipk', 'apk'), ('apk', 'ipk')]:
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as directory:
                package_dir = Path(directory) / 'bin/packages/x86_64/action'
                package_dir.mkdir(parents=True)
                for filename in self.filenames(other):
                    (package_dir / filename).write_bytes(b'package')
                result = self.run_collection(directory, fmt, '24.10.5')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'::error::Expected', result.stdout)


if __name__ == '__main__':
    unittest.main()
