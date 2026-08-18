"""Built-in diagnostic profiler adapters.

Imports are lazy so ``python -m bakudo.performance.adapters.process`` can run
the guest-side wrapper without importing that module once through this package
and then executing it a second time through ``runpy``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .process import ProcessProfilerAdapter
    from .python_sampling import PythonSamplingAdapter
    from .synthetic import SyntheticProfilerAdapter

__all__ = [
    "ProcessProfilerAdapter",
    "PythonSamplingAdapter",
    "SyntheticProfilerAdapter",
]


def __getattr__(name: str) -> Any:
    if name == "ProcessProfilerAdapter":
        from .process import ProcessProfilerAdapter

        return ProcessProfilerAdapter
    if name == "PythonSamplingAdapter":
        from .python_sampling import PythonSamplingAdapter

        return PythonSamplingAdapter
    if name == "SyntheticProfilerAdapter":
        from .synthetic import SyntheticProfilerAdapter

        return SyntheticProfilerAdapter
    raise AttributeError(name)
