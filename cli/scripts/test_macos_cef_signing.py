import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "sign_cef", Path(__file__).with_name("sign-macos-cef-app.py"))
sign_cef = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sign_cef)


class SigningTests(unittest.TestCase):
    def test_signs_real_binaries_before_enclosing_bundles(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Kavla.app"
            framework = app / "Contents/Frameworks/Chromium Embedded Framework.framework"
            helper = app / "Contents/Frameworks/Kavla Helper (Renderer).app"
            binaries = [app / "Contents/MacOS/Kavla",
                        app / "Contents/MacOS/kavla-cef",
                        framework / "Versions/A/Chromium Embedded Framework",
                        helper / "Contents/MacOS/Kavla Helper (Renderer)"]
            for binary in binaries:
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(b"\xcf\xfa\xed\xfe" + b"mock binary")
            alias = framework / "Chromium Embedded Framework"
            alias.symlink_to("Versions/A/Chromium Embedded Framework")
            (framework / "Versions/Current").symlink_to("A")
            resource = app / "Contents/Info.plist"
            resource.write_text("<plist/>")
            with patch.object(sign_cef.subprocess, "run") as run:
                sign_cef.sign_bundle(app)
            signed = [Path(call.args[0][-1]) for call in run.call_args_list]
            self.assertEqual(set(signed), set(binaries + [framework, helper, app]))
            self.assertEqual(len(signed), len(set(signed)))
            self.assertEqual(signed[-1], app)
            for binary in binaries:
                for bundle in [framework, helper, app]:
                    if bundle in binary.parents:
                        self.assertLess(signed.index(binary), signed.index(bundle))
            self.assertTrue(all(call.kwargs['check'] for call in run.call_args_list))

    def test_signing_failure_stops_packaging(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Kavla.app"
            app.mkdir()
            with patch.object(sign_cef.subprocess, "run",
                              side_effect=subprocess.CalledProcessError(1, "codesign")):
                with self.assertRaises(subprocess.CalledProcessError):
                    sign_cef.sign_bundle(app)


if __name__ == "__main__":
    unittest.main()
