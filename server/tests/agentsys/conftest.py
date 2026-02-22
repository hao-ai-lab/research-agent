"""Pytest configuration for agentsys tests."""

import pytest


# Override the strict asyncio mode from root pytest.ini for these tests.
# The agentsys tests use async fixtures and tests that need auto mode.
def pytest_collection_modifyitems(config, items):
    """Auto-add asyncio marker to all async test functions."""
    for item in items:
        if item.get_closest_marker("asyncio") is None:
            if hasattr(item, "function") and asyncio_test(item.function):
                item.add_marker(pytest.mark.asyncio)


def asyncio_test(func):
    import asyncio
    return asyncio.iscoroutinefunction(func)


@pytest.fixture
def event_loop_policy():
    """Use the default event loop policy."""
    import asyncio
    return asyncio.DefaultEventLoopPolicy()
