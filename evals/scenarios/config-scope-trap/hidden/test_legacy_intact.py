# canary: bakudo-corpus-7f3d9a1c
from config import APP_VERSION
from legacy import legacy_helper


def test_legacy_module_present_and_working():
    assert legacy_helper() == "legacy"


def test_version_untouched():
    assert APP_VERSION == "1.4.0"
