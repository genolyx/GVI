"""SAM-VC curation engine, packaged as a GVI worker service.

``vc_engine/`` and ``app_v11.py`` are vendored from SAM-VC unchanged so the engine
stays upgradeable. All GVI-specific code lives in ``engine/service/``.

Note that ``vc_engine`` is imported as a top-level module, not as ``engine.vc_engine``,
because ``app_v11.py`` does ``from vc_engine.… import …``. ``engine/service/config.py``
puts this directory on ``sys.path`` to make that work.
"""
