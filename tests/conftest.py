def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "live_abox: drives the real abox 0.6.0 binary in a KVM microVM "
        "(skipped unless ABOX_LIVE=1; requires `abox project trust` + "
        "`abox env warm` on this checkout)",
    )
