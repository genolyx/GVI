"""Variant Curation engine package.

Incremental extraction of cohesive, importable, testable modules out of the
monolithic ``app_v11.py``. The package is named ``vc_engine`` rather than
``engine`` so it does not collide with the GVI ``engine.service`` package.

The SAM-VC Flask workbench is not part of this tree. GVI's worker loads
``app_v11`` in-process and is the only supported UI.
"""
