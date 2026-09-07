"""PyInstaller entry point for the frozen service.

`inferno_service/__main__.py` uses relative imports, which only work when it is
run as part of its package (`python -m inferno_service`). PyInstaller executes
its entry script as a bare `__main__` with no parent package, so pointing it
straight at that file fails at the first `from .binaries import ...`. This
imports the package properly and calls into it instead.
"""

import multiprocessing
import sys

from inferno_service.__main__ import main

if __name__ == "__main__":
    # uvicorn's reloader and any worker pool would otherwise re-run the frozen
    # bootloader and fork the whole app.
    multiprocessing.freeze_support()
    sys.exit(main())
