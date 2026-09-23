/**
 * Copy/paste report text — logic explanation drives the theoretical section.
 */
(function (global) {
  function softStripHtml(s) {
    if (s == null) return '';
    let t = String(s);
    t = t.replace(/<\s*br\s*\/?\s*>\s*<\s*br\s*\/?\s*>/gi, '\n\n');
    t = t.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    const tmp = document.createElement('div');
    tmp.innerHTML = t;
    return tmp.textContent || tmp.innerText || '';
  }

  function stripHtmlForCopy(s) {
    if (s == null) return '';
    let t = String(s);
    t = t.replace(/<\s*br\s*\/?\s*>\s*<\s*br\s*\/?\s*>/gi, '\n\n');
    t = t.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    const tmp = document.createElement('div');
    tmp.innerHTML = t;
    const decoded = tmp.textContent || tmp.innerText || '';
    const lines = decoded.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim());
    const out = [];
    let blank = 0;
    for (const line of lines) {
      if (line) {
        out.push(line);
        blank = 0;
      } else {
        if (blank === 0 && out.length) out.push('');
        blank++;
      }
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }

  function stripSupplementalAlertLinesForCopyPaste(s) {
    if (s == null || s === '') return s;
    let t = String(s).replace(/\*/g, '');
    const lines = t.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const L = line.trim();
      if (/variant\s+not\s+found\s+in\s+main\s+text/i.test(L) && /supplement/i.test(L)) continue;
      out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Plain-text logic block — same content as the Logic explanation panel. */
  function buildLogicCopyBlock(pd) {
    return String(pd.logic_explanation_plaintext || '').trim();
  }

  function buildUniprotCopyLine(pd) {
    if (!pd || pd.noncoding_track) return 'UniProt: Domain — N/A (noncoding)';
    if (!pd.uniprot_domain_checked && !pd.uniprot_link && !pd.has_critical_domain) {
      return 'UniProt: Domain — N/A';
    }
    if (pd.has_critical_domain && pd.critical_domain_names) {
      return `UniProt: Domain — Found (${pd.critical_domain_names})`;
    }
    if (pd.uniprot_domain_checked) {
      return 'UniProt: Domain — No domain of interest';
    }
    return 'UniProt: Domain';
  }

  function buildMetadomeCopyLine(pd) {
    if (!pd || pd.noncoding_track) return 'MetaDome: N/A (noncoding)';
    if (!pd.metadome_checked || pd.metadome_status === 'skipped') {
      return 'MetaDome: N/A';
    }
    if (pd.metadome_status === 'ready' && pd.metadome_summary) {
      const link = (pd.metadome_link || '').trim();
      return link
        ? `MetaDome: ${pd.metadome_summary} (${link})`
        : `MetaDome: ${pd.metadome_summary}`;
    }
    if (pd.metadome_status === 'processing') {
      const link = (pd.metadome_link || '').trim();
      return link
        ? `MetaDome: landscape building — see ${link}`
        : 'MetaDome: landscape building — re-run for score';
    }
    if (pd.metadome_error) {
      return `MetaDome: ${pd.metadome_error}`;
    }
    if (pd.metadome_link) {
      return `MetaDome: see ${pd.metadome_link}`;
    }
    return 'MetaDome: N/A';
  }

  function applyLiteratureToState(state, res) {
    const lit = res.literature || {};
    if (lit.clinical_summary) {
      state.clinicalAI = stripSupplementalAlertLinesForCopyPaste(lit.clinical_summary);
    } else if (lit.clinical_error) {
      state.clinicalAI = 'Failed to load clinical AI summary.';
    } else if (lit.status === 'download_failed') {
      state.clinicalAI = 'No literature parsed (Download Failed)';
      state.functionalAI = 'No functional studies found (Download Failed)';
    } else {
      state.clinicalAI = '';
    }
    if (lit.functional_summary) {
      state.functionalAI = stripSupplementalAlertLinesForCopyPaste(lit.functional_summary);
    } else if (lit.functional_error) {
      state.functionalAI = 'Failed to load functional AI summary.';
    } else if (lit.status === 'download_failed') {
      /* set above */
    } else if (!state.functionalAI) {
      state.functionalAI = 'No functional studies found';
    }
  }

  function populateCopyPasteState(res, ctx) {
    const pd = res.parsed_data || {};

    const state = {
      logicText: buildLogicCopyBlock(pd),
      clinvar: '',
      hgmd: 'HGMD: Yes',
      clinicalAI: '',
      functionalAI: 'No functional studies found',
      uniprotLine: buildUniprotCopyLine(pd),
      metadomeLine: buildMetadomeCopyLine(pd),
    };

    if (pd.clinvar_rcv && pd.clinvar_sig) {
      let cvStr = `${pd.clinvar_sig} (VID: ${pd.clinvar_rcv})`;
      if (pd.clinvar_lab && pd.clinvar_lab !== 'Unknown Submitter') {
        cvStr += `:\n  - ${pd.clinvar_lab}`;
      }
      if (pd.clinvar_year && pd.clinvar_year !== 'Unknown Date') {
        cvStr += `, ${pd.clinvar_year}`;
      }
      state.clinvar = cvStr;
    } else if (pd.clinvar_sig) {
      state.clinvar = pd.clinvar_sig;
    } else {
      state.clinvar = 'Not Found';
    }

    if (pd.hgmd_local) state.hgmd = pd.hgmd_local;

    applyLiteratureToState(state, res);
    return state;
  }

  function assembleCopyPasteOutput(state, opts) {
    const out = [];

    out.push('Clinical:');
    const noClinvar =
      !state.clinvar || state.clinvar.includes('Not found') || state.clinvar === '';
    const noHgmd =
      !state.hgmd ||
      state.hgmd.toLowerCase().includes('not found') ||
      state.hgmd.includes('Search');
    const noLit =
      !state.clinicalAI ||
      state.clinicalAI.includes('Pending') ||
      state.clinicalAI.includes('Failed') ||
      state.clinicalAI.includes('No literature');

    let voi = 'VOI';
    if (opts.gene && opts.c_dot) voi = `${String(opts.gene).trim()} ${String(opts.c_dot).trim()}`;
    else if (opts.voi) voi = opts.voi;

    const negativeParts = [];
    const noSources = ['RARE', 'Internal Database', 'Google/Google Scholar'];
    if (noHgmd) noSources.unshift('HGMD');

    if (noClinvar) {
      negativeParts.push(`${voi} has not been described in ClinVar`);
      negativeParts.push(`No evidence found in ${noSources.join(', ')}`);
    } else {
      negativeParts.push(`${voi} has no evidence found in ${noSources.join(', ')}`);
    }
    out.push(negativeParts.join(' // '));

    if (!noClinvar) out.push(`ClinVar: ${state.clinvar}`);
    if (!noHgmd) out.push(state.hgmd);
    if (!noLit) out.push(state.clinicalAI);

    out.push('\nFunctional section:');
    if (
      state.functionalAI &&
      !state.functionalAI.includes('Pending') &&
      !state.functionalAI.includes('Failed') &&
      !state.functionalAI.toLowerCase().includes('no functional studies')
    ) {
      out.push(state.functionalAI);
    } else {
      out.push('No functional studies found');
    }

    out.push('\nLogic explanation:');
    out.push(state.logicText && state.logicText.trim() ? state.logicText.trim() : 'N/A');

    // Explicit domain / tolerance footer (under UniProt, as in standalone copy/paste).
    out.push(state.uniprotLine || 'UniProt: Domain — N/A');
    out.push(state.metadomeLine || 'MetaDome: N/A');

    return softStripHtml(out.join('\n'));
  }

  function buildCopyPasteText(res, ctx) {
    if (!res || !res.parsed_data) return '';
    const meta = (typeof global !== 'undefined' && global.WB_ENTRY_META) || {};
    const pd = res.parsed_data;
    const opts = {
      gene: ctx.gene || meta.gene || pd.gene_symbol || pd.gene || res.effective_gene || '',
      c_dot: ctx.c_dot || meta.c_dot || pd.hgvs_c || '',
      voi: ctx.voi,
    };
    const state = populateCopyPasteState(res, opts);
    return assembleCopyPasteOutput(state, opts);
  }

  global.CopyPasteBuilder = {
    buildCopyPasteText,
    populateCopyPasteState,
    assembleCopyPasteOutput,
    stripHtmlForCopy,
    stripSupplementalAlertLinesForCopyPaste,
    buildLogicCopyBlock,
    buildUniprotCopyLine,
    buildMetadomeCopyLine,
  };
})(typeof window !== 'undefined' ? window : this);
