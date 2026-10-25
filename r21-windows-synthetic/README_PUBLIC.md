# R21 public synthetic Windows test

Synthetic-only test harness. Private identifiers have been replaced with deterministic fake values. Never call against any real Host profile. No scripts that modify PANYA-HOME are included. Windows runner verifies Python 3.13 msvcrt lock, os._exit failure recovery, SQLite backup and rollback in fresh temp fixtures. Passing is NOT live Host integration proof.