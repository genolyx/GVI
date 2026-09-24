/**
 * Parsed-data panel for workbench review.
 */
(function (global) {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  }

  /** Strip ClinVar/HGMD catalogues appended to nmd_math (shown under P/LP pills). */
  function stripNmdMathCatalogue(nmdMath) {
    let s = String(nmdMath || '').trim();
    if (!s) return '';
    s = s.replace(/<br\s*\/?>\s*<br\s*\/?>\s*<span[^>]*>\s*ClinVar P\/LP.*/is, '');
    s = s.replace(/ClinVar P\/LP(?: and HGMD catalogue)? variants.*/is, '');
    return s.trim().replace(/[;, ]+$/, '');
  }

  function isTruncatingConsequence(pd) {
    const c = pd.original_consequence || pd.consequence || '';
    return (
      c.includes('nonsense')
      || c.includes('frameshift')
      || c === 'start_lost'
      || pd.is_splice_frameshift
      || pd.splice_is_in_frame === false
    );
  }

  function clingenHaploScorePresent(score) {
    const s = score == null ? '' : String(score).trim();
    return s !== '' && s.toUpperCase() !== 'N/A';
  }

  function buildClinGenPill(pd) {
    const link = pd.clingen_link || '';
    if (!pd.has_clingen || !link) {
      return (
        '<span class="data-pill" style="border-color: rgba(255,255,255,0.2); background: rgba(255, 255, 255, 0.05); color: #e2e8f0;">' +
        'ClinGen Curation: <strong>N/A</strong></span>'
      );
    }
    const viewLink =
      '<a href="' + esc(link) + '" target="_blank" style="color:#60a5fa; text-decoration: underline;">View</a>';
    const pillOpen =
      '<span class="data-pill" style="border-color: #60a5fa; background: rgba(59, 130, 246, 0.1); color: #60a5fa;">ClinGen Curation: <strong>';
    if (clingenHaploScorePresent(pd.clingen_haplo_score)) {
      return pillOpen + 'Haplo Score ' + esc(pd.clingen_haplo_score) + ' (' + viewLink + ')</strong></span>';
    }
    return pillOpen + 'Curated gene (' + viewLink + ')</strong></span>';
  }

  function buildNoncodingCurationHtml(pd) {
    if (!pd || !pd.noncoding_track) return '';
    const links = pd.noncoding_clinvar_search_links || {};
    const checklist = pd.noncoding_curation_checklist || [];
    const neighbors = pd.noncoding_clinvar_neighbors || [];
    const region = pd.noncoding_critical_region;
    const inCrit = pd.noncoding_in_critical_region;
    const kind = (pd.hgvs_dna_kind || 'n').toUpperCase();

    let regionHtml = '';
    if (region) {
      const tag = inCrit
        ? '<strong style="color:#34d399;">inside critical region</strong>'
        : '<strong style="color:#fbbf24;">outside critical region</strong>';
      const pmid = region.pmid
        ? ` <span style="opacity:0.85;">(PMID ${esc(region.pmid)})</span>`
        : '';
      regionHtml =
        `<div style="margin:6px 0 8px;font-size:0.9em;color:#e2e8f0;">` +
        `${esc(region.label || 'Critical region')}${pmid}: ${tag}</div>`;
    }

    const mark = { done: '✓', todo: '☐', na: '–' };
    let listHtml = '';
    if (checklist.length) {
      listHtml =
        '<ul style="margin:4px 0 8px 1.1em;padding:0;font-size:0.88em;line-height:1.45;color:#e2e8f0;">' +
        checklist
          .map((it) => {
            const m = mark[it.status] || '☐';
            return `<li><b>${m}</b> ${esc(it.text || '')}</li>`;
          })
          .join('') +
        '</ul>';
    }

    const linkDefs = [
      ['allele', 'This n. allele'],
      ['gene_plp', 'Gene P/LP'],
      ['gene_all', 'All gene'],
      ['critical_region', 'Critical region'],
      ['this_vid', 'This VID'],
    ];
    const linkPills = linkDefs
      .filter(([k]) => links[k])
      .map(
        ([k, label]) =>
          `<span class="data-pill"><a href="${esc(links[k])}" target="_blank" rel="noopener" style="color:#93c5fd;text-decoration:underline;">${esc(label)}</a></span>`
      )
      .join('');

    let neighborHtml = '';
    if (neighbors.length) {
      const rows = neighbors
        .slice(0, 8)
        .map((h) => {
          const lab = esc(h.hgvs || `pos ${h.pos || '?'}`);
          const sig = esc(h.significance || 'P/LP');
          const vid = esc(h.vid || '?');
          const href = esc(h.link || `https://www.ncbi.nlm.nih.gov/clinvar/variation/${h.vid}/`);
          const crit = h.in_critical_region ? ' <span style="color:#34d399;">[critical]</span>' : '';
          return `${lab} (${sig})${crit} <a href="${href}" target="_blank" style="color:#fbbf24;text-decoration:underline;">[VID ${vid}]</a>`;
        })
        .join('<br>');
      neighborHtml =
        `<div style="margin-top:8px;font-size:0.88em;color:#e2e8f0;line-height:1.55;"><strong>Nearby ClinVar P/LP:</strong><br>${rows}</div>`;
    } else {
      neighborHtml =
        '<div style="margin-top:6px;font-size:0.85em;color:#94a3b8;">Nearby ClinVar P/LP in scanned window: none (or VCF unavailable).</div>';
    }

    return `
<section class="eval-section" style="border-color: rgba(56, 189, 248, 0.35); background: rgba(14, 165, 233, 0.06);">
  <h3 class="eval-section-title" style="color:#7dd3fc;border-bottom-color: rgba(56,189,248,0.25);">Noncoding RNA curation (${esc(kind)}.)</h3>
  <div style="font-size:0.9em;color:#cbd5e1;margin-bottom:6px;">
    Use RNA structure, ClinVar <code>n.</code>, genomes AF, inheritance, and phenotype — not p./REVEL/NMD.
  </div>
  ${regionHtml}
  ${listHtml}
  <div class="eval-pill-row" style="margin-top:4px;">${linkPills}</div>
  ${neighborHtml}
</section>`;
  }

  function buildLocalClinvarScanPill(pd) {
    if (!pd || !pd.local_clinvar_scan_performed) return '';
    const nm = esc((pd.transcript || '').trim() || 'your NM');
    const txBase = esc(((pd.transcript || '').trim().replace(/\.\d+$/, '') || 'transcript'));
    const hits = pd.local_clinvar_hits_on_transcript;
    const ctx = pd.local_clinvar_context_count;
    const note = esc(pd.local_clinvar_scan_note || '');
    const titleAttr = note ? ' title="' + note + '"' : '';

    if (pd.local_clinvar_hits_on_transcript > 0 && pd.local_clinvar_context_count === 0) {
      return (
        '<div class="eval-allele-wide"><span class="data-pill" style="border-color: #fbbf24; background: rgba(251, 191, 36, 0.15); color: #fcd34d; display: block; max-width: fit-content;"' +
        titleAttr +
        '>⚠️ ClinVar allelic scan: <strong>P/LP on ' + nm + ' but none classified</strong><br>' +
        '<span style="font-size:11px;font-weight:normal;opacity:0.9;margin-top:4px;display:inline-block;line-height:1.5;">' +
        hits + ' transcript-named P/LP — please flag for engine review.</span></span></div>'
      );
    }

    if (pd.local_clinvar_used_hgvs_fallback) {
      return (
        '<div class="eval-allele-wide"><span class="data-pill" style="border-color: #38bdf8; background: rgba(56, 189, 248, 0.14); color: #7dd3fc; display: block; max-width: fit-content;"' +
        titleAttr +
        '>ℹ️ ClinVar allelic scan: <strong>HGVS fallback on ' + nm + '</strong><br>' +
        '<span style="font-size:11px;font-weight:normal;opacity:0.9;margin-top:4px;display:inline-block;line-height:1.5;">' +
        hits + ' P/LP name this transcript; MyVariant snpeff had 0 on ' + txBase + '.' +
        (ctx > 0 ? ' Used ' + ctx + ' for same-aa / regional context.' : '') +
        '</span></span></div>'
      );
    }

    return (
      '<div class="eval-allele-wide"><span class="data-pill" style="border-color: rgba(255,255,255,0.15); background: rgba(255,255,255,0.04); color: #cbd5e1; display: block; max-width: fit-content;"' +
      titleAttr +
      '>ClinVar allelic scan: <strong>' + hits + ' P/LP on ' + nm + '</strong>' +
      (ctx > 0 ? ' · ' + ctx + ' used for context' : '') +
      '</span></div>'
    );
  }

  // 3-letter → 1-letter amino-acid code (HGVS p.) so we can render
  // "p.Ala71fsTer6 (p.A71fs*6)" alongside the panel's standard 3-letter form.
  const _AA3_TO_1 = {
    Ala: 'A', Arg: 'R', Asn: 'N', Asp: 'D', Cys: 'C',
    Gln: 'Q', Glu: 'E', Gly: 'G', His: 'H', Ile: 'I',
    Leu: 'L', Lys: 'K', Met: 'M', Phe: 'F', Pro: 'P',
    Ser: 'S', Thr: 'T', Trp: 'W', Tyr: 'Y', Val: 'V',
    Sec: 'U', Pyl: 'O', Asx: 'B', Glx: 'Z', Xle: 'J',
    Xaa: 'X', Ter: '*'
  };
  function hgvsP3to1(label) {
    if (!label) return '';
    let s = String(label);
    // Drop a leading "p." so we can re-add it cleanly.
    s = s.replace(/^p\./, '');
    // Replace each 3-letter code (case-insensitive) with its 1-letter form.
    s = s.replace(/([A-Z][a-z]{2})/g, function (m) {
      const k = m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
      return Object.prototype.hasOwnProperty.call(_AA3_TO_1, k) ? _AA3_TO_1[k] : m;
    });
    // Ter -> * already handled above; also normalize "fsTer" -> "fs*" for the
    // common short clinical form even when Ter wasn't matched as 3-letter.
    s = s.replace(/Ter/g, '*');
    return 'p.' + s;
  }

  /** Same markdown/PMID formatting as the review literature sections */
  function formatLiteratureSummaryHtml(raw) {
    if (raw == null || raw === '') return '';
    return String(raw)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>')
      .replace(/- (.*?)<br>/g, '<li style="margin-left:20px;">$1</li>')
      .replace(
        /PMID[^\d]*(\d+)/gi,
        'PMID: <a href="https://pubmed.ncbi.nlm.nih.gov/$1/" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:underline;">$1</a>'
      );
  }

  /** What /api/summarize_literature instructs Gemini to report (OUTPUT STYLE in app_v11). */
  function clinicalLiteratureSpecHtml() {
    return `<details class="lit-review-spec">
  <summary>What this clinical review reports</summary>
  <p class="lit-review-spec-lead">For each paper that describes patients with <strong>this exact variant</strong>, one line starting with <code>PMID …:</code> including:</p>
  <ul>
    <li><strong>Mutation</strong> — gene + HGVSc (and p. if the paper states it)</li>
    <li><strong>Patients</strong> — how many probands/carriers with this allele (or &ldquo;unclear&rdquo;)</li>
    <li><strong>Disorder</strong> — phenotype / disease name(s) attributed in that paper</li>
    <li><strong>Inheritance</strong> — de novo, familial/inherited, unclear, or mixed</li>
    <li><strong>Affected relatives</strong> — who carries the allele if inherited (or &ldquo;not stated&rdquo;)</li>
  </ul>
  <p class="lit-review-spec-note">Literature download searches <strong>gene + HGVSc</strong> and <strong>gene + p.</strong> (primary and ClinVar alternate transcripts on the same VID). Papers without this allele and without supplemental variant lists are omitted. Supplement-only cases show a ⚠️ supplemental-files alert instead.</p>
</details>`;
  }

  function isNoClinicalPatientsSummary(summary) {
    return /^Papers downloaded but no patients with variants in publications\.?$/i.test(
      String(summary || '').trim(),
    );
  }

  function clinicalLiteratureNoPatientsNote() {
    return `<p class="lit-review-spec-note lit-review-no-patients">
  <strong>What this result means:</strong> PDFs were downloaded and read, but <em>none</em> described a patient or carrier with
  <strong>this exact variant</strong> (your curated HGVSc, alternate isoforms, or p. forms). Papers that only discuss other
  alleles in the same gene are omitted. If authors place variant lists only in supplementary tables, you would see a
  ⚠️ supplemental-files alert instead of this message — check the downloaded folder for Excel/CSV supplements.
</p>`;
  }

  function literatureReviewSection(title, titleColor, borderColor, bgColor, summary, specHtml) {
    const body = formatLiteratureSummaryHtml(summary);
    const noPatients = isNoClinicalPatientsSummary(summary) ? clinicalLiteratureNoPatientsNote() : '';
    return `<section class="eval-section lit-review-section" style="border-color: ${borderColor}; background: ${bgColor};">
  <h3 class="eval-section-title" style="color:${titleColor};border-bottom-color:${borderColor};">${title}</h3>
  ${specHtml || ''}
  <div class="lit-review-body">${body}</div>
  ${noPatients}
</section>`;
  }

  function spliceInSilicoSourceLabel(pd) {
    if (!pd) return '';
    const hasSai = pd.spliceai_ds_ag !== undefined && pd.spliceai_ds_dg !== undefined;
    const hasPang = pd.pangolin_ds_sg !== undefined && pd.pangolin_ds_sl !== undefined;
    if (hasSai || hasPang) {
      const src = pd.spliceai_in_silico_source;
      if (src === 'emedgene') {
        return '<span class="eval-section-source" title="SpliceAI delta scores and Δbp supplied with the variant">Provided</span>';
      }
      if (src === 'emedgene+broad') {
        return '<span class="eval-section-source" title="SpliceAI Δ scores supplied with the variant; Δbp offsets from Broad API">Provided + Broad</span>';
      }
      if (src === 'broad') {
        return '<span class="eval-section-source" title="SpliceAI and Pangolin via Broad Institute API">Broad API</span>';
      }
      // Legacy saved runs (before spliceai_in_silico_source)
      if (pd.spliceai_emg_full_fallback || (pd.spliceai_from_emg && pd.splice_api_error)) {
        return '<span class="eval-section-source" title="SpliceAI scores supplied with the variant">Provided</span>';
      }
      if (pd.spliceai_from_emg) {
        if (pd.spliceai_emg_ds_pending_broad_dp || pd.spliceai_fetched) {
          return '<span class="eval-section-source" title="SpliceAI Δ scores supplied with the variant; Δbp from Broad API">Provided + Broad</span>';
        }
        return '<span class="eval-section-source" title="SpliceAI scores supplied with the variant">Provided</span>';
      }
      return '<span class="eval-section-source" title="SpliceAI and Pangolin via Broad Institute API">Broad API</span>';
    }
    if (pd.splice_api_error) {
      return '<span class="eval-section-source" title="In silico splice predictors could not be loaded">Unavailable</span>';
    }
    return '';
  }

  function stripHtmlForCopy(s) {
        if (s == null) return '';
        let t = String(s);
        t = t.replace(/<\s*br\s*\/?\s*>\s*<\s*br\s*\/?\s*>/gi, '\n\n');
        t = t.replace(/<\s*br\s*\/?\s*>/gi, '\n');
        const tmp = document.createElement('div');
        tmp.innerHTML = t;
        const decoded = tmp.textContent || tmp.innerText || '';
        const lines = decoded.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim());
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

  function renderClassifierParsedPanel(res) {
    const pd = res.parsed_data || {};
    if (!pd || !Object.keys(pd).length) return { html: '<p class="muted">No parsed data in saved run.</p>', copyText: '' };

let exonPill = '';
const vExon = res.parsed_data.variant_exon ?? res.parsed_data.snpeff_exon_rank;
const nmdTotal = res.parsed_data.nmd_exon_total ?? res.parsed_data.snpeff_exon_total ?? res.parsed_data.mrna_exon_total;
if (vExon && nmdTotal) {
    let pExon = res.parsed_data.snpeff_exon_rank;
    let total = nmdTotal;

    if (vExon !== pExon) {
        exonPill = `<span class="data-pill" style="border-color: rgba(255,255,255,0.2); background: rgba(59, 130, 246, 0.1); color: #93c5fd;">Exon: <strong>${vExon}/${total}</strong> <span style="margin-left: 6px; font-style: italic; color: #bfdbfe;">(PTC in Exon ${pExon}/${total})</span></span>`;
    } else if (pExon === total) {
        exonPill = `<span class="data-pill" style="border-color: rgba(255,255,255,0.2); background: rgba(59, 130, 246, 0.1); color: #93c5fd;">Exon: <strong>${vExon}/${total}</strong> <span style="margin-left: 6px; font-style: italic; color: #bfdbfe;">(Final Exon)</span></span>`;
    } else if (res.parsed_data.nmd_exon_distance !== undefined && res.parsed_data.nmd_exon_distance !== null) {
        exonPill = `<span class="data-pill" style="border-color: rgba(255,255,255,0.2); background: rgba(59, 130, 246, 0.1); color: #93c5fd;">Exon: <strong>${vExon}/${total}</strong> <span style="margin-left: 6px; font-style: italic; color: #bfdbfe;">(${res.parsed_data.nmd_exon_distance}nt to junction)</span></span>`;
    } else {
        exonPill = `<span class="data-pill" style="border-color: rgba(255,255,255,0.2); background: rgba(255, 255, 255, 0.05); color: #e2e8f0;">Exon: <strong>${vExon}/${total}</strong></span>`;
    }
}

let nmdPill = '';
const csq = res.parsed_data.original_consequence || res.parsed_data.consequence || '';
if (res.parsed_data.cryptic_natural_stop_preserved) {
    nmdPill = `<span class="data-pill" title="No premature termination codon — the cryptic splice is in-frame and the native stop codon is preserved (just shifted by N/3 codons). NMD requires a PTC, so it is not applicable here." style="border-color: rgba(125, 211, 252, 0.5); color: #bae6fd; background: rgba(56, 189, 248, 0.08);">NMD: <strong style="color:#bae6fd;">N/A (no PTC)</strong></span>`;
} else if (csq.includes('nonsense') || csq.includes('frameshift') || res.parsed_data.is_splice_frameshift || res.parsed_data.splice_is_in_frame === false || csq === 'start_lost') {
    const escapes = res.parsed_data.nmd_escape ? "Yes" : "No";
    const nmdTip = esc(res.parsed_data.nmd_decision_basis || (
        res.parsed_data.nmd_escape
            ? 'Transcript escapes NMD (last-exon or penultimate junction rule). Truncation % is shown separately.'
            : 'Transcript predicted to undergo NMD-mediated decay.'
    ));
    nmdPill = `<span class="data-pill" title="${nmdTip}">NMD Escape: <strong style="color: ${res.parsed_data.nmd_escape ? '#fca5a5' : '#7dd3fc'};">${escapes}</strong></span>`;
}

let inframePreservedPill = '';
if (res.parsed_data.cryptic_natural_stop_preserved) {
    const aaChange = res.parsed_data.cryptic_net_aa_change || '';
    const stopAa = res.parsed_data.cryptic_preserved_stop_aa_pos;
    const insBp = (res.parsed_data.cryptic_inserted_cdna || '').length;
    const insTxt = insBp > 0 ? ` ${insBp} nt insert` : '';
    const stopTxt = stopAa ? `; native stop preserved at p.Ter${stopAa}` : '';
    const aaTxt = aaChange ? ` (${aaChange} aa)` : '';
    inframePreservedPill = `<span class="data-pill" title="In-frame cryptic splice that does NOT truncate the protein. The native terminator is just shifted by N/3 codons, not lost. NMD pathway does not apply." style="border-color: #fcd34d; color: #fde68a; background: rgba(251, 191, 36, 0.10);">In-frame splice insert${aaTxt}: <strong style="color: #fde68a;">no truncation${insTxt}${stopTxt}</strong></span>`;
}

let truncPill = '';
let truncSkipIsoLbl = '';
if (res.parsed_data.spliceai_competing_splice_isoforms && res.parsed_data.exon_skip_oof_ptc_aa != null) {
    truncSkipIsoLbl = ' <span style="color:#94a3b8;font-weight:600;font-size:0.82em;">(whole-exon skip isoform)</span>';
}
const _truncFracRaw = Number(res.parsed_data.nmd_escape_truncation_fraction);
const _pLenForExt = Number(res.parsed_data.protein_length);
const _novelStopForExt = Number(res.parsed_data.novel_stop_aa);
const _isFsExtension = (
    !res.parsed_data.cryptic_natural_stop_preserved
    && Number.isFinite(_truncFracRaw)
    && _truncFracRaw < 0
    && _truncFracRaw > -5 // reject absurd −570-style artifacts from missing WT length
    && Number.isFinite(_pLenForExt) && _pLenForExt > 0
    && Number.isFinite(_novelStopForExt) && _novelStopForExt > _pLenForExt
    && isTruncatingConsequence(res.parsed_data)
);
if (_isFsExtension) {
    const extPct = (Math.abs(_truncFracRaw) * 100).toFixed(1);
    const pLen = res.parsed_data.protein_length;
    const novelStop = res.parsed_data.novel_stop_aa;
    const d_aas = res.parsed_data.downstream_aas;
    let fsOnset = res.parsed_data.protein_start;
    if (res.parsed_data.consequence === 'frameshift' && res.parsed_data.hgvs_p) {
        const mOnset = res.parsed_data.hgvs_p.match(/p\.(?:[A-Z][a-z]{2}|[A-Z*])(\d+)/);
        if (mOnset) fsOnset = parseInt(mOnset[1], 10);
    }
    const showStop = (Number.isFinite(novelStop) && novelStop > 0)
        ? `Stop: ${fsOnset || '?'} [onset] + ${d_aas != null ? d_aas : '?'} [shift] = ${novelStop}/${pLen} (past WT end)`
        : `extends past ${pLen}-aa WT terminus`;
    const ptcLabel = res.parsed_data.hgvs_p || '';
    const ptcSuffix = ptcLabel
        ? ` &middot; <span style="color:#fde68a;background:rgba(251,191,36,0.12);padding:1px 6px;border-radius:3px;font-weight:600;">${ptcLabel}</span>`
        : '';
    truncPill = `<span class="data-pill" title="Frameshift stop codon is past the native protein terminus — the ORF is extended into the 3′ UTR, not truncated." style="border-color: #fcd34d; color: #fde68a; background: rgba(251, 191, 36, 0.10);">3′ extension: <strong style="color: #fde68a;">+${extPct}% (${showStop})</strong>${ptcSuffix}</span>`;
} else if (!res.parsed_data.cryptic_natural_stop_preserved && res.parsed_data.nmd_escape_truncation_fraction > 0 && isTruncatingConsequence(res.parsed_data)) {
    const pct = (res.parsed_data.nmd_escape_truncation_fraction * 100).toFixed(1);
    const pLen = res.parsed_data.protein_length;
    // Prefer the cryptic-splice / junction PTC fields over the canonical
    // protein_start when they exist, because canonical can carry a
    // `0` placeholder from an early init that loses to setdefault().
    const cryptTL = res.parsed_data.cryptic_truncated_protein_length;
    const junctionPTC = res.parsed_data.junction_model_ptc_position;
    const exonSkipPTC = res.parsed_data.exon_skip_oof_ptc_aa;
    let pStart = res.parsed_data.protein_start;
    if ((!pStart || pStart <= 0) && Number.isFinite(cryptTL) && cryptTL > 0) {
        pStart = cryptTL + 1;
    }
    if (res.parsed_data.consequence === 'start_lost') {
        // For 5' Start Loss, the missing portion is the distance to the next Met
        const nextMetPos = res.parsed_data.next_methionine_position || Math.round(res.parsed_data.nmd_escape_truncation_fraction * pLen) + 1;
        if (nextMetPos !== -1) {
            const metExon = res.parsed_data.next_methionine_exon;
            const exonStr = metExon ? ` / Exon ${metExon}` : '';
            truncPill = `<span class="data-pill" style="border-color: #fca5a5; color: #fca5a5; background: rgba(239, 68, 68, 0.1);">5' Missing: <strong style="color: #fca5a5;">${pct}% (Next Met: ${nextMetPos}${exonStr})</strong></span>`;
        } else {
            truncPill = `<span class="data-pill" style="border-color: #fca5a5; color: #fca5a5; background: rgba(239, 68, 68, 0.1);">5' Missing: <strong style="color: #fca5a5;">100.0% (No Viable Next Met)</strong></span>`;
        }
    } else {
        // For 3' Nonsense/Frameshift
        const d_aas = res.parsed_data.downstream_aas;
        const novelStop = res.parsed_data.novel_stop_aa;
        let fsOnset = pStart;
        if (res.parsed_data.consequence === 'frameshift' && res.parsed_data.hgvs_p) {
            const mOnset = res.parsed_data.hgvs_p.match(/p\.(?:[A-Z][a-z]{2}|[A-Z*])(\d+)/);
            if (mOnset) fsOnset = parseInt(mOnset[1], 10);
        }
        if (Number.isFinite(novelStop) && novelStop > 0 && fsOnset === novelStop
                && Number.isFinite(d_aas) && d_aas > 0) {
            fsOnset = novelStop - d_aas;
        }
        let stopPos = null;
        if (Number.isFinite(junctionPTC) && junctionPTC > 0) stopPos = junctionPTC;
        else if (Number.isFinite(exonSkipPTC) && exonSkipPTC > 0) stopPos = exonSkipPTC;
        else if (Number.isFinite(novelStop) && novelStop > 0) stopPos = novelStop;
        else if (Number.isFinite(fsOnset) && fsOnset > 0 && Number.isFinite(d_aas) && d_aas > 0) stopPos = fsOnset + d_aas;
        const ptcLabel = res.parsed_data.exon_skip_predicted_hgvs_p
                       || res.parsed_data.junction_model_hgvs_p
                       || res.parsed_data.cryptic_splice_ptc
                       || res.parsed_data.hgvs_p
                       || (Number.isFinite(d_aas) && d_aas > 0 && Number.isFinite(pStart) && pStart > 0
                              ? `p.X${pStart}fs*${d_aas + 1}` : '');
        let ptcSuffix = '';
        if (ptcLabel) {
            const ptcOne = hgvsP3to1(ptcLabel);
            // Only append the 1-letter form when it actually differs from the
            // 3-letter form (e.g., a 3-letter "p.Ala71fsTer6" → "p.A71fs*6";
            // skip if input was already 1-letter or had no AA codes to convert).
            const showOne = ptcOne && ptcOne !== ptcLabel ? ` <span style="color:#fca5a5;opacity:0.85;">(${ptcOne})</span>` : '';
            ptcSuffix = ` &middot; <span style="color:#fca5a5;background:rgba(239,68,68,0.12);padding:1px 6px;border-radius:3px;font-family:inherit;font-weight:600;">${ptcLabel}</span>${showOne}`;
        }
        const showStop = (Number.isFinite(stopPos) && stopPos > 0)
                        ? `Stop: ${fsOnset || '?'} [onset] + ${d_aas} [Shift] = ${stopPos}/${pLen}`
                        : (Number.isFinite(pStart) && pStart > 0
                              ? `Stop: ${pStart}/${pLen}`
                              : `Stop: position unresolved/${pLen}`);
        truncPill = `<span class="data-pill" style="border-color: #fca5a5; color: #fca5a5; background: rgba(239, 68, 68, 0.1);">Truncated: <strong style="color: #fca5a5;">${pct}% (${showStop})</strong>${ptcSuffix}</span>${truncSkipIsoLbl}`;
    }
}

let truncThresholdPill = '';
const TRUNC_SEVERE_THRESHOLD = 0.10;
const truncFracVal = Number(res.parsed_data.nmd_escape_truncation_fraction) || 0;
const _csqForTrunc = String(res.parsed_data.consequence || '');
if (!res.parsed_data.cryptic_natural_stop_preserved && truncFracVal < 0 && truncFracVal > -5
    && Number(res.parsed_data.protein_length) > 0
    && Number(res.parsed_data.novel_stop_aa) > Number(res.parsed_data.protein_length)
    && isTruncatingConsequence(res.parsed_data)) {
    const absExt = Math.abs(truncFracVal);
    const isLongExt = absExt >= TRUNC_SEVERE_THRESHOLD;
    const threshLbl = isLongExt ? '≥10% 3′ extension' : '<10% 3′ extension';
    const threshTip = isLongExt
        ? 'Frameshift extends the ORF by at least 10% past the native stop.'
        : 'Frameshift extends the ORF by less than 10% past the native stop — evaluate whether the altered C-terminus is clinically critical.';
    truncThresholdPill = `<span class="data-pill" title="${esc(threshTip)}" style="border-color: #fcd34d; color: #fde68a; background: rgba(251, 191, 36, 0.08);">Extension: <strong>${threshLbl}</strong> (+${(absExt * 100).toFixed(1)}%)</span>`;
} else if (
    !res.parsed_data.cryptic_natural_stop_preserved
    && truncFracVal > 0
    && _csqForTrunc === 'start_lost'
) {
    // Start-loss % is N-terminal (to next Met), not C-terminal truncation.
    const isUnder10Start = truncFracVal < TRUNC_SEVERE_THRESHOLD;
    const threshLbl = isUnder10Start ? '<10% start-loss' : '≥10% start-loss';
    const nextMet = res.parsed_data.next_methionine_position;
    const metBit = (nextMet && nextMet !== -1) ? ` · next Met aa ${nextMet}` : '';
    const threshTip = isUnder10Start
        ? 'Next in-frame Met is close enough that <10% of the N-terminus is skipped (re-initiation pathway).'
        : 'Next in-frame Met is far enough that ≥10% of the N-terminus is skipped — severe start-loss.';
    const threshColor = isUnder10Start ? '#fcd34d' : '#fca5a5';
    truncThresholdPill = `<span class="data-pill" title="${esc(threshTip)}" style="border-color: ${threshColor}; color: ${threshColor}; background: rgba(239, 68, 68, 0.08);">N-terminal: <strong>${threshLbl}</strong> (${(truncFracVal * 100).toFixed(1)}%${metBit})</span>`;
} else if (!res.parsed_data.cryptic_natural_stop_preserved && truncFracVal > 0 && isTruncatingConsequence(res.parsed_data)) {
    const isUnder10Trunc = truncFracVal > 0 && truncFracVal <= TRUNC_SEVERE_THRESHOLD;
    const threshLbl = isUnder10Trunc ? '<10% rule' : '≥10% rule';
    const threshTip = isUnder10Trunc
        ? 'Less than 10% of the protein is lost — evaluate downstream P/LP and UniProt domains in the truncated segment.'
        : 'At least 10% of the protein is lost — severe C-terminal truncation (PVS1 pathway when NMD is escaped).';
    const threshColor = isUnder10Trunc ? '#fcd34d' : '#fca5a5';
    truncThresholdPill = `<span class="data-pill" title="${esc(threshTip)}" style="border-color: ${threshColor}; color: ${threshColor}; background: rgba(239, 68, 68, 0.08);">Truncation: <strong>${threshLbl}</strong> (${(truncFracVal * 100).toFixed(1)}%)</span>`;
}

let spliceaiPill = '';
if (res.parsed_data.spliceai_ds_ag !== undefined && res.parsed_data.spliceai_ds_dg !== undefined) {
    let ag = res.parsed_data.spliceai_ds_ag.toFixed(2);
    let al = res.parsed_data.spliceai_ds_al.toFixed(2);
    let dg = res.parsed_data.spliceai_ds_dg.toFixed(2);
    let dl = res.parsed_data.spliceai_ds_dl.toFixed(2);
    
    let fmtDp = (val) => val === "" || val === undefined ? "" : ` (${val > 0 ? '+' : ''}${val}bp)`;
    let dpAG = fmtDp(res.parsed_data.spliceai_dp_ag);
    let dpAL = fmtDp(res.parsed_data.spliceai_dp_al);
    let dpDG = fmtDp(res.parsed_data.spliceai_dp_dg);
    let dpDL = fmtDp(res.parsed_data.spliceai_dp_dl);

    let cAG = ag > 0.20 ? '#fca5a5' : '#e2e8f0';
    let cAL = al > 0.20 ? '#fca5a5' : '#e2e8f0';
    let cDG = dg > 0.20 ? '#fca5a5' : '#e2e8f0';
    let cDL = dl > 0.20 ? '#fca5a5' : '#e2e8f0';

    spliceaiPill = `
    <span class="data-pill">SpliceAI Acc Gain (AG, 3\u2032): <strong style="color:${cAG};">${ag}${dpAG}</strong></span>
    <span class="data-pill">SpliceAI Acc Loss (AG, 3\u2032): <strong style="color:${cAL};">${al}${dpAL}</strong></span>
    <span class="data-pill">SpliceAI Don Gain (GT, 5\u2032): <strong style="color:${cDG};">${dg}${dpDG}</strong></span>
    <span class="data-pill">SpliceAI Don Loss (GT, 5\u2032): <strong style="color:${cDL};">${dl}${dpDL}</strong></span>
    `;
} else if (res.parsed_data.splice_api_error) {
    spliceaiPill = `<span class="data-pill">SpliceAI Deep-Learning: <strong style="color:var(--text-muted);">${res.parsed_data.splice_api_error}</strong></span>`;
}

let pangolinPill = '';
if (res.parsed_data.pangolin_ds_sg !== undefined && res.parsed_data.pangolin_ds_sl !== undefined) {
    let sg = res.parsed_data.pangolin_ds_sg.toFixed(2);
    let sl = res.parsed_data.pangolin_ds_sl.toFixed(2);
    
    let fmtDp = (val) => val === "" || val === undefined ? "" : ` (${val > 0 ? '+' : ''}${val}bp)`;
    let dpSG = fmtDp(res.parsed_data.pangolin_dp_sg);
    let dpSL = fmtDp(res.parsed_data.pangolin_dp_sl);

    let cSG = sg > 0.20 ? '#fca5a5' : '#e2e8f0';
    let cSL = sl > 0.20 ? '#fca5a5' : '#e2e8f0';

    pangolinPill = `
    <span class="data-pill">Pangolin Splice Gain: <strong style="color:${cSG};">${sg}${dpSG}</strong></span>
    <span class="data-pill">Pangolin Splice Loss: <strong style="color:${cSL};">${sl}${dpSL}</strong></span>
    `;
} else if (res.parsed_data.splice_api_error) {
    pangolinPill = `<span class="data-pill">Pangolin Sub-Net: <strong style="color:var(--text-muted);">${res.parsed_data.splice_api_error}</strong></span>`;
}

let autoPill = '';
let domainPill = '';
let skippedExonPill = '';

// Independent badge for the In-Frame Skipped-Exon ClinVar P/LP scan.
// Fires whenever the backend actually ran the GLOBAL_VCF.fetch lookup
// over the deleted-exon coordinates, so a "Not Found" result is
// affirmed instead of silently absent.
if (res.parsed_data.has_pathogenic_in_deleted_exon) {
    const skN = res.parsed_data.skipped_exon_pathogenic_clinvar_count || res.parsed_data.skipped_exon_pathogenic_hit_count || 1;
    const skLink = res.parsed_data.skipped_exon_pathogenic_clinvar_list_link || res.parsed_data.deleted_exon_pathogenic_link;
    const skLbl = skN > 1 ? `Skipped exon P/LP: ${skN} matched` : `Skipped exon P/LP: matched`;
    if (skLink) {
        skippedExonPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1);"><a href="${skLink}" target="_blank" style="color:#fca5a5; text-decoration: underline; font-weight: bold;">${skLbl}</a></span>`;
    } else {
        skippedExonPill = `<span class="data-pill" style="border-color: #fca5a5; color: #fca5a5; background: rgba(239, 68, 68, 0.1);">⚠️ Skipped Exon P/LP: <strong>Found!</strong></span>`;
    }
} else if (res.parsed_data.skipped_exon_plp_checked) {
    skippedExonPill = `<span class="data-pill">Skipped Exon P/LP Search: <strong>Not Found</strong></span>`;
} else if (res.parsed_data.skipped_exon_plp_vcf_unavailable) {
    skippedExonPill = `<span class="data-pill" style="border-color:#fbbf24;color:#fcd34d;">Skipped Exon P/LP Search: <strong>VCF unavailable</strong></span>`;
} else if (
    res.parsed_data.spliceai_exon_skip_spliceai_primary
    || res.parsed_data.splice_deleted_coords
    || (res.parsed_data.splice_is_in_frame != null && res.parsed_data.splice_fraction_lost != null)
) {
    skippedExonPill = `<span class="data-pill" style="border-color:#fbbf24;color:#fcd34d;">Skipped Exon P/LP Search: <strong>Not run</strong></span>`;
}

// <10% rule: domain/downstream evidence pills; NMD-escape variants always show domain when checked.
const isUnder10 = truncFracVal > 0 && truncFracVal <= TRUNC_SEVERE_THRESHOLD;
const showTruncEvidencePills = isUnder10 || (
    !!res.parsed_data.nmd_escape && truncFracVal > 0
);
const downstreamScanDone = !!res.parsed_data.downstream_plp_scan_performed;
const upstreamScanDone = !!res.parsed_data.upstream_plp_scan_performed;

function downstreamPlpNotFoundPill(dir) {
    const dsSearch = res.parsed_data.downstream_pathogenic_clinvar_search_link;
    if (dsSearch) {
        return `<span class="data-pill">${dir} P/LP Search: <strong>Not Found</strong> (<a href="${dsSearch}" target="_blank" style="color:#e2e8f0; text-decoration: underline;">ClinVar</a>)</span>`;
    }
    return `<span class="data-pill">${dir} P/LP Search: <strong>Not Found</strong></span>`;
}

if (showTruncEvidencePills) {
    const dir = res.parsed_data.consequence === 'start_lost' ? 'Upstream of Next Met' : 'Downstream';

    // Domain Badge
    if (res.parsed_data.has_critical_domain) {
        const dNames = res.parsed_data.critical_domain_names || 'Functional Region';
        if (res.parsed_data.critical_domain_link) {
            domainPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1); color:#fca5a5;">Domain Search: Found (<a href="${res.parsed_data.critical_domain_link}" target="_blank" style="color:#fca5a5; text-decoration: underline; font-weight: bold;">${dNames}</a>)</span>`;
        } else {
            domainPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1); color:#fca5a5;">Domain Search: <strong>Found (${dNames})</strong></span>`;
        }
    } else if (res.parsed_data.uniprot_domain_checked) {
        domainPill = `<span class="data-pill">Domain Search: <strong>Not Found</strong></span>`;
    }

    // P/LP Badge — matched ClinVar hits only (<10% requires explicit scan result)
    if (isUnder10 && res.parsed_data.auto_downstream_pathogenic && dir === 'Downstream') {
        const dsN = res.parsed_data.downstream_pathogenic_clinvar_count || res.parsed_data.downstream_pathogenic_hit_count || 0;
        const dsLink = res.parsed_data.downstream_pathogenic_clinvar_list_link || res.parsed_data.auto_downstream_pathogenic_link;
        const dsLbl = dsN > 1 ? `${dir} P/LP: ${dsN} matched` : `${dir} P/LP: matched`;
        if (dsLink) {
            autoPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1);"><a href="${dsLink}" target="_blank" style="color:#fca5a5; text-decoration: underline; font-weight: bold;">${dsLbl}</a></span>`;
        } else {
            autoPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1); color:#fca5a5;">${dir} P/LP Search: <strong>Found!</strong></span>`;
        }
    } else if (isUnder10 && res.parsed_data.auto_upstream_pathogenic && dir.includes('Upstream')) {
        const usN = res.parsed_data.upstream_pathogenic_clinvar_count || res.parsed_data.upstream_pathogenic_hit_count || 0;
        const usLink = res.parsed_data.upstream_pathogenic_clinvar_list_link || res.parsed_data.auto_upstream_pathogenic_link;
        const usLbl = usN > 1 ? `${dir} P/LP: ${usN} matched` : `${dir} P/LP: matched`;
        if (usLink) {
            autoPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1);"><a href="${usLink}" target="_blank" style="color:#fca5a5; text-decoration: underline; font-weight: bold;">${usLbl}</a></span>`;
        } else {
            autoPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1); color:#fca5a5;">${dir} P/LP Search: <strong>Found!</strong></span>`;
        }
    } else if (isUnder10) {
        autoPill = downstreamPlpNotFoundPill(dir);
    }
} else if (downstreamScanDone && !res.parsed_data.auto_downstream_pathogenic) {
    autoPill = downstreamPlpNotFoundPill('Downstream');
} else if (upstreamScanDone && !res.parsed_data.auto_upstream_pathogenic) {
    autoPill = `<span class="data-pill">Upstream P/LP Search: <strong>Not Found</strong></span>`;
} else if (res.parsed_data.has_pathogenic_in_deleted_exon) {
    const skN2 = res.parsed_data.skipped_exon_pathogenic_clinvar_count || res.parsed_data.skipped_exon_pathogenic_hit_count || 1;
    const skLink2 = res.parsed_data.skipped_exon_pathogenic_clinvar_list_link || res.parsed_data.deleted_exon_pathogenic_link;
    const skLbl2 = skN2 > 1 ? `Skipped exon P/LP: ${skN2} matched` : `Skipped exon P/LP: matched`;
    if (skLink2) {
        autoPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1);"><a href="${skLink2}" target="_blank" style="color:#fca5a5; text-decoration: underline; font-weight: bold;">${skLbl2}</a></span>`;
    } else {
        autoPill = `<span class="data-pill" style="border-color: #fca5a5; color: #fca5a5; background: rgba(239, 68, 68, 0.1);">⚠️ Skipped Exon P/LP: <strong>Found!</strong></span>`;
    }
} else if (res.parsed_data.auto_downstream_pathogenic || res.parsed_data.auto_upstream_pathogenic) {
    const dsLinkFb = res.parsed_data.downstream_pathogenic_clinvar_list_link || res.parsed_data.auto_downstream_pathogenic_link;
    const usLinkFb = res.parsed_data.upstream_pathogenic_clinvar_list_link || res.parsed_data.auto_upstream_pathogenic_link;
    const dsNFb = res.parsed_data.downstream_pathogenic_clinvar_count || 0;
    const usNFb = res.parsed_data.upstream_pathogenic_clinvar_count || 0;
    if (dsLinkFb) {
        const dsLblFb = dsNFb > 1 ? `Downstream P/LP: ${dsNFb} matched` : 'Downstream P/LP: matched';
        autoPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1);"><a href="${dsLinkFb}" target="_blank" style="color:#fca5a5; text-decoration: underline; font-weight: bold;">${dsLblFb}</a></span>`;
    } else if (usLinkFb) {
        const usLblFb = usNFb > 1 ? `Upstream P/LP: ${usNFb} matched` : 'Upstream P/LP: matched';
        autoPill = `<span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.1);"><a href="${usLinkFb}" target="_blank" style="color:#fca5a5; text-decoration: underline; font-weight: bold;">${usLblFb}</a></span>`;
    } else {
        autoPill = `<span class="data-pill" style="border-color: #fca5a5; color: #fca5a5; background: rgba(239, 68, 68, 0.1);">Found Pathogenic Variant Nearby</span>`;
    }
}

if (skippedExonPill && autoPill && /Skipped exon P\/LP/i.test(autoPill) && /Skipped exon P\/LP/i.test(skippedExonPill)) {
    skippedExonPill = '';
}

let mechanismAlertPill = '';
const mech = res.parsed_data.disease_mechanism;
const spliceLofPrimary = !!(
    res.parsed_data.splice_lof_mechanism_established
    || res.parsed_data.spliceai_exon_skip_spliceai_primary
);
const isMechanismTruncating = !res.parsed_data.cryptic_natural_stop_preserved && (
    csq.includes('nonsense') || csq.includes('frameshift') || csq === 'start_lost' || res.parsed_data.is_splice_frameshift || res.parsed_data.splice_is_in_frame === false
);
if (isMechanismTruncating) {
    if (mech === 'Unknown' || mech === 'GOF') {
        if (spliceLofPrimary) {
            mechanismAlertPill = `<span class="data-pill" style="border-color: #10b981; background: rgba(16, 185, 129, 0.1); color:#34d399;">Mechanism Check: <strong>Splice LOF primary (whole-exon skip)</strong> — truncation expected even when gene mechanism is ${mech}</span>`;
        } else {
            mechanismAlertPill = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: #fca5a5; background: rgba(239, 68, 68, 0.2); color:#fca5a5; display: inline-flex; font-size:1.05em; padding:8px 12px; border-width:2px; box-shadow: 0 0 10px rgba(239,68,68,0.3);">⚠️ CRITICAL: TRUNCATING MUTATION WITHOUT ESTABLISHED LOF MECHANISM (${mech})</span></div>`;
        }
    } else if (mech === 'LOF' || mech === 'Both') {
        mechanismAlertPill = `<span class="data-pill" style="border-color: #10b981; background: rgba(16, 185, 129, 0.1); color:#34d399;">Mechanism Check: <strong>${mech} (Safely matches Truncation)</strong></span>`;
    }
}

let altPill = '';
let pm5LocalPill = '';
let hotspotPill = '';
if (res.parsed_data.c_allele_search_link || res.parsed_data.p_allele_search_link) {
    let fullTheoretical = "None found.";
    let search_c = res.parsed_data.c_allele_search_link || '#';
    let search_p = res.parsed_data.p_allele_search_link || '#';
    
    let pm5Badge = '';
    if (res.parsed_data.different_pathogenic) {
        if (res.parsed_data.different_pathogenic_details) {
            let det = res.parsed_data.different_pathogenic_details;
            let p_str = det.hgvs_p || det.hgvs_c || 'Pathogenic Colocalization';
            pm5Badge = `<span style="background: rgba(251, 191, 36, 0.2); color: #fbbf24; padding: 2px 6px; border-radius: 4px; margin-left: 8px; border: 1px solid rgba(251, 191, 36, 0.5); font-size: 11px; font-weight: bold;">⚠️ PM5: ${p_str} (Pathogenic) <a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${det.vid}/" target="_blank" style="color:#fbbf24; text-decoration:underline;">[VID: ${det.vid}]</a></span>`;
        } else {
            pm5Badge = `<span style="background: rgba(251, 191, 36, 0.2); color: #fbbf24; padding: 2px 6px; border-radius: 4px; margin-left: 8px; border: 1px solid rgba(251, 191, 36, 0.5); font-size: 11px; text-transform: uppercase; font-weight: bold; letter-spacing: 0.5px;">⚠️ External PM5 Detected <a href="${search_p}" target="_blank" style="color:#fbbf24; text-decoration:underline;">(Search)</a></span>`;
        }
    }
    if (res.parsed_data.alternate_alleles && res.parsed_data.alternate_alleles.length > 0) {
        let totalAlts = res.parsed_data.alternate_alleles.length;
        
        let altText = res.parsed_data.alternate_alleles.map(a => `${a.hgvs_c} (${a.significance}) [ClinVar Variation ID: ${a.vid || '?'}]`).join(', ');
        let uiAltText = res.parsed_data.alternate_alleles.map(a => `${a.hgvs_c} (${a.significance}) <a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${a.vid}/" target="_blank" style="color:#fbbf24; text-decoration:underline;">[VID: ${a.vid || '?'}]</a>`).join('<br>');
        
        fullTheoretical = `True Alternate Alleles: ${altText}`;
        altPill = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: #fbbf24; background: rgba(251, 191, 36, 0.1); color: #fbbf24; display: block; max-width: fit-content;">⚠️ True Alternate Alleles: <strong>Yes (${totalAlts} variants found)</strong> <a href="${search_c}" target="_blank" style="color:#fbbf24; text-decoration: underline; margin-left:4px;">(Search ClinVar)</a>${pm5Badge}<br><span style="font-size:12px; font-weight:normal; opacity:0.9; margin-top:4px; display:inline-block; line-height:1.6;">${uiAltText}</span></span></div>`;
    } else if (res.parsed_data.vus_alternate_alleles && res.parsed_data.vus_alternate_alleles.length > 0) {
        let totalVus = res.parsed_data.vus_alternate_alleles.length;
        
        let altText = res.parsed_data.vus_alternate_alleles.map(a => `${a.hgvs_c} (${a.significance}) [ClinVar Variation ID: ${a.vid || '?'}]`).join(', ');
        let uiAltText = res.parsed_data.vus_alternate_alleles.map(a => `${a.hgvs_c} (${a.significance}) <a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${a.vid}/" target="_blank" style="color:#d1d5db; text-decoration:underline;">[VID: ${a.vid || '?'}]</a>`).join('<br>');
        
        fullTheoretical = `VUS/Conflicting Alternate Alleles: ${altText}`;
        altPill = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: #6b7280; background: rgba(107, 114, 128, 0.1); color: #d1d5db; display: block; max-width: fit-content;">True Alternate Alleles: <strong>None Pathogenic, but found ${totalVus} VUS/Conflicting</strong> <a href="${search_c}" target="_blank" style="color:#d1d5db; text-decoration: underline; margin-left:4px;">(Search ClinVar)</a>${pm5Badge}<br><span style="font-size:12px; font-weight:normal; opacity:0.9; margin-top:4px; display:inline-block; line-height:1.6;">${uiAltText}</span></span></div>`;
    } else if ((res.parsed_data.same_protein_position_alleles && res.parsed_data.same_protein_position_alleles.length > 0)
        || (res.parsed_data.pm5_local_alleles && res.parsed_data.pm5_local_alleles.length > 0)) {
        altPill = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: rgba(255,255,255,0.2); background: rgba(255, 255, 255, 0.05); color: #e2e8f0; display: block; max-width: fit-content;">True Alternate Alleles: <strong>None at this exact HGVSc allele</strong> <a href="${search_c}" target="_blank" style="color:#e2e8f0; text-decoration: underline;">(Search)</a>${pm5Badge}<br><span style="font-size:11px;font-weight:normal;opacity:0.85;margin-top:4px;display:inline-block;">Same-amino-acid / PM5 context is listed below.</span></span></div>`;
    } else {
        altPill = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: rgba(255,255,255,0.2); background: rgba(255, 255, 255, 0.05); color: #e2e8f0; display: block; max-width: fit-content;">True Alternate Alleles: <strong>None (<a href="${search_c}" target="_blank" style="color:#e2e8f0; text-decoration: underline;">Search</a>)</strong>${pm5Badge}</span></div>`;
    }

    const sjAlts = res.parsed_data.splice_junction_alleles || [];
    if (sjAlts.length > 0) {
        const sjUi = sjAlts.map(a => `${a.hgvs_c} (${a.significance}) <a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${a.vid}/" target="_blank" style="color:#fbbf24; text-decoration:underline;">[VID: ${a.vid || '?'}]</a>`).join('<br>');
        altPill += `<div class="eval-allele-wide"><span class="data-pill" style="border-color: #fbbf24; background: rgba(251, 191, 36, 0.1); color: #fbbf24; display: block; max-width: fit-content; margin-top:8px;">Splice junction allele(s): <strong>${sjAlts.length} P/LP at same donor/acceptor</strong><br><span style="font-size:12px; font-weight:normal; opacity:0.9; margin-top:4px; display:inline-block; line-height:1.6;">${sjUi}</span></span></div>`;
    }
    
    function _alleleLabel(a) {
        const c = a.hgvs_c || '';
        const p = a.hgvs_p || '';
        if (p && c && c !== p) return `${c} (${p})`;
        return p || c || '?';
    }

    if (res.parsed_data.same_protein_position_alleles && res.parsed_data.same_protein_position_alleles.length > 0) {
        let totalSp = res.parsed_data.same_protein_position_alleles.length;
        const userNm = (res.parsed_data.transcript || '').trim();
        const nmLabel = userNm ? `<code>${userNm}</code>` : 'your curated NM';
        let spText = res.parsed_data.same_protein_position_alleles.map(a =>
            `${_alleleLabel(a)} (${a.significance}) [ClinVar Variation ID: ${a.vid || '?'}]`).join(', ');
        let uiSpText = res.parsed_data.same_protein_position_alleles.map(a =>
            `${_alleleLabel(a)} (${a.significance}) <a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${a.vid}/" target="_blank" style="color:#c4b5fd; text-decoration:underline;">[VID: ${a.vid || '?'}]</a>`).join('<br>');
        if (fullTheoretical === "None found.") fullTheoretical = `Alternative HGVSc/p. on ${userNm || 'your NM'} (same aa): ${spText}`;
        else fullTheoretical += ` | Alternative on ${userNm || 'your NM'}: ${spText}`;
        pm5LocalPill = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: #8b5cf6; background: rgba(139, 92, 246, 0.12); color: #c4b5fd; display: block; max-width: fit-content;">Alternative HGVSc/p. on ${nmLabel} (literature): <strong>${totalSp} at same aa ${res.parsed_data.protein_start || '?'}</strong><br><span style="font-size:11px; font-weight:normal; opacity:0.85;">Same transcript as your variant — different nucleotide and/or protein change (e.g. c.532 vs c.533).</span><br><span style="font-size:12px; font-weight:normal; opacity:0.9; margin-top:4px; display:inline-block; line-height:1.6;">${uiSpText}</span></span></div>`;
    }

    if (res.parsed_data.pm5_local_alleles && res.parsed_data.pm5_local_alleles.length > 0) {
        let totalPM5 = res.parsed_data.pm5_local_alleles.length;
        let hsText = res.parsed_data.pm5_local_alleles.map(a => `${_alleleLabel(a)} (${a.significance}) [ClinVar Variation ID: ${a.vid || '?'}]`).join(', ');
        let uiHsText = res.parsed_data.pm5_local_alleles.map(a => `${_alleleLabel(a)} (${a.significance}) <a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${a.vid}/" target="_blank" style="color:#a855f7; text-decoration:underline;">[VID: ${a.vid || '?'}]</a>`).join('<br>');
        
        if (fullTheoretical === "None found.") fullTheoretical = `PM5 Local Alleles: ${hsText}`;
        else fullTheoretical += ` | PM5 Local Alleles: ${hsText}`;
        
        pm5LocalPill = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: #a855f7; background: rgba(168, 85, 247, 0.1); color: #a855f7; display: block; max-width: fit-content;">⚠️ PM5 Structural Overlaps: <strong>Yes (${totalPM5} variant(s) at same amino acid)</strong> <a href="${search_p}" target="_blank" style="color:#a855f7; text-decoration: underline; margin-left:4px;">(Search ClinVar)</a><br><span style="font-size:12px; font-weight:normal; opacity:0.9; margin-top:4px; display:inline-block; line-height:1.6;">${uiHsText}</span></span></div>`;
    }

    if (res.parsed_data.alternate_transcript_literature && res.parsed_data.alternate_transcript_literature.length > 0) {
        const curVid = (res.parsed_data.clinvar_rcv || '').trim();
        let totalLit = res.parsed_data.alternate_transcript_literature.length;
        const userNm = (res.parsed_data.transcript || '').trim();
        const litNote = `Alternate isoform HGVS (${totalLit} ClinVar name(s) on your VID${curVid ? ' ' + curVid : ''}) included in literature search`;
        if (fullTheoretical === "None found.") fullTheoretical = litNote;
        else fullTheoretical += ` | ${litNote}`;
        const isoBlock = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: #0ea5e9; background: rgba(14, 165, 233, 0.12); color: #7dd3fc; display: block; max-width: fit-content;">Alternate isoform HGVS (your variant${curVid ? ', VID ' + curVid : ''}): <strong>${totalLit} other name(s)</strong><br><span style="font-size:11px; font-weight:normal; opacity:0.85;">Same ClinVar record${userNm ? ' — not ' + userNm + ' numbering' : ''}. Literature search includes these isoform / genomic HGVS aliases automatically.</span></span></div>`;
        hotspotPill = hotspotPill ? hotspotPill + isoBlock : isoBlock;
    }

    if (res.parsed_data.regional_hotspot && res.parsed_data.regional_hotspot.length > 0) {
        let totalHS = res.parsed_data.regional_hotspot.length;
        let hsText = res.parsed_data.regional_hotspot.map(a => `${_alleleLabel(a)} (${a.significance}) [ClinVar Variation ID: ${a.vid || '?'}]`).join(', ');
        let uiHsText = res.parsed_data.regional_hotspot.map(a => `${_alleleLabel(a)} (${a.significance}) <a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${a.vid}/" target="_blank" style="color:#f43f5e; text-decoration:underline;">[VID: ${a.vid || '?'}]</a>`).join('<br>');
        
        if (fullTheoretical === "None found.") fullTheoretical = `Regional hotspot (your NM ±5 aa): ${hsText}`;
        else fullTheoretical += ` | Regional hotspot (your NM): ${hsText}`;
        
        const regionalBlock = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: #f43f5e; background: rgba(244, 63, 94, 0.1); color: #f43f5e; display: block; max-width: fit-content;">Regional hotspot (your transcript ±5 aa): <strong>${totalHS} P/LP nearby</strong><br><span style="font-size:12px; font-weight:normal; opacity:0.9; margin-top:4px; display:inline-block; line-height:1.6;">${uiHsText}</span></span></div>`;
        hotspotPill = hotspotPill ? hotspotPill + regionalBlock : regionalBlock;
    }

}

let clinvarScanPill = buildLocalClinvarScanPill(res.parsed_data);

let exonicFsPrimaryPill = '';
if (res.parsed_data.exonic_indel_frameshift_primary) {
    exonicFsPrimaryPill = `<div class="eval-allele-wide"><span class="data-pill" style="border-color: #38bdf8; background: rgba(56, 189, 248, 0.12); color: #7dd3fc; display: block; max-width: fit-content;">Primary mechanism: <strong>exonic frameshift → PTC</strong><br><span style="font-size:11px;font-weight:normal;opacity:0.9;margin-top:4px;display:inline-block;line-height:1.5;">Splice-site overlap is secondary unless RNA confirms aberrant splicing as the dominant product.</span></span></div>`;
}

let clingenPill = buildClinGenPill(res.parsed_data);


let grPill = `<span class="data-pill" style="border-color: rgba(255,255,255,0.2); background: rgba(255, 255, 255, 0.05); color: #e2e8f0;">GeneReviews: <strong><a href="${res.parsed_data.genereviews_link}" target="_blank" style="color:#e2e8f0; text-decoration: underline;">Search Title</a></strong></span>`;

let litPillId = "litPill_" + Date.now();
let litPill = false ? `<span id="${litPillId}" class="data-pill" style="border-color: #f59e0b; background: rgba(245, 158, 11, 0.1); color: #fcd34d;">PDF Download: <strong>In Progress...</strong></span>` : '';

let hgmdBadge = `<span class="data-pill">HGMD: <strong><a href="${res.parsed_data.hgmd_link}" target="_blank" style="color:var(--primary); text-decoration:underline;">Search</a></strong></span>`;
if (res.parsed_data.hgmd_local && res.parsed_data.hgmd_local !== "HGMD: Not Found") {
    let hgmdText = res.parsed_data.hgmd_local.replace("HGMD: ", "");
    hgmdText = hgmdText.replace(/\[PMID: ([\d.]+)\]/, (match, pmid) => {
        let cleanPmid = pmid.replace(".0", "");
        return `[<a href="https://pubmed.ncbi.nlm.nih.gov/${cleanPmid}/" target="_blank" style="color:#fcd34d; text-decoration:underline;">PMID: ${cleanPmid}</a>]`;
    });
    hgmdBadge = `<span class="data-pill" style="border-color: #f59e0b; background: rgba(245, 158, 11, 0.1); color: #fcd34d;">HGMD: <strong>${hgmdText}</strong></span>`;
}
if (Array.isArray(res.parsed_data.hgmd_excel_pmids) && res.parsed_data.hgmd_excel_pmids.length > 0) {
    const seen = new Set();
    const uniq = [];
    for (const p of res.parsed_data.hgmd_excel_pmids) {
        const s = String(p).replace(/\.0$/, '').trim();
        if (s && !seen.has(s)) {
            seen.add(s);
            uniq.push(s);
        }
    }
    if (uniq.length > 0) {
        const links = uniq.map(p =>
            `<a href="https://pubmed.ncbi.nlm.nih.gov/${p}/" target="_blank" style="color:#fcd34d;text-decoration:underline;">${p}</a>`
        ).join(', ');
        const tail = ` · <span style="font-weight:600;">PMIDs</span> (${uniq.length}): ${links}`;
        if (res.parsed_data.hgmd_local && res.parsed_data.hgmd_local !== "HGMD: Not Found") {
            hgmdBadge = hgmdBadge.replace('</strong></span>', `${tail}</strong></span>`);
        } else {
            hgmdBadge = `<span class="data-pill" style="border-color: #f59e0b; background: rgba(245, 158, 11, 0.1); color: #fcd34d;">HGMD: <strong><a href="${res.parsed_data.hgmd_link}" target="_blank" style="color:#fcd34d;text-decoration:underline;">Search</a>${tail}</strong></span>`;
        }
    }
}

function buildLiteratureIndexSection(idx) {
    if (!idx || !idx.available || !(idx.hit_count > 0) || !Array.isArray(idx.papers) || !idx.papers.length) {
        return '';
    }
    const overlap = new Set((idx.hgmd_overlap_pmids || []).map(String));
    const cards = idx.papers.map((paper) => {
        const pmid = esc(paper.pmid || '');
        const url = esc(paper.pubmed_url || (`https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`));
        const hgmdTag = overlap.has(String(paper.pmid))
            ? ' <span style="color:#fcd34d;font-weight:600;">(HGMD PMID for this variant)</span>'
            : '';
        const rawSummary = String(paper.summary || '').trim();
        const shortSummary = rawSummary.length > 180 ? (rawSummary.slice(0, 177) + '…') : rawSummary;
        const summaryHtml = `<p style="margin:0 0 0.35rem;font-size:0.95rem;line-height:1.4;color:#e2e8f0;font-weight:500;">${
            shortSummary ? esc(shortSummary) : 'No one-sentence summary for this PMID.'
        }</p>`;
        const abstract = String(paper.abstract || '').trim();
        const abstractHtml = abstract
            ? `<p style="margin:0 0 0.45rem;font-size:0.88rem;line-height:1.45;color:#94a3b8;">${esc(abstract)}</p>`
            : '';
        const lines = (paper.variants || []).map((v) => {
            const line = v.line || [
                v.variant || '',
                v.source ? `found in: ${v.source}` : '',
            ].filter(Boolean).join(' — ');
            return `<p style="margin:0.28rem 0 0;font-size:0.88rem;line-height:1.45;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd5e1;">${esc(line)}</p>`;
        }).join('');
        const more = paper.extra
            ? `<p style="margin:0.28rem 0 0;font-size:0.85rem;color:#94a3b8;">${esc(String(paper.extra))} more in this paper</p>`
            : '';
        return `<article style="margin-bottom:14px;">
          <p style="margin:0 0 0.35rem;font-size:0.95rem;"><a href="${url}" target="_blank" rel="noopener" style="color:#38bdf8;text-decoration:underline;font-weight:600;">PMID ${pmid}</a>${hgmdTag}</p>
          ${summaryHtml}
          ${abstractHtml}
          ${lines}${more}
        </article>`;
    }).join('');
    const q = idx.query ? `<span style="color:#94a3b8;font-weight:400;"> · query ${esc(idx.query)}</span>` : '';
    return `<section class="eval-section" style="border-color: rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.06);">
  <h3 class="eval-section-title" style="color:#7dd3fc;border-bottom-color: rgba(56,189,248,0.25);">Literature Index${q}</h3>
  <p style="margin:0 0 0.75rem;font-size:0.9rem;color:#cbd5e1;">${esc(idx.message || '')}</p>
  ${cards}
</section>`;
}
const literatureIndexHtml = buildLiteratureIndexSection(res.parsed_data.literature_index);

// Render Web Data
const displayCsq = res.parsed_data.original_consequence || res.parsed_data.consequence || '';
const _csqLow = String(displayCsq || '').toLowerCase();
const _isSpliceCtx = (
    _csqLow.includes('splice')
    || _csqLow === 'intron_variant'
    || !!(res.parsed_data.splice_frame_math || '').trim()
    || !!(res.parsed_data.splice_products_panel_html || '').trim()
    || res.parsed_data.canonical_splice_junction
);
let _svPayload = res.parsed_data.splice_viz || null;
if (!_svPayload && _isSpliceCtx) {
    _svPayload = {
        eligible: false,
        reason: 'Splice exon map not in this saved run — re-run the batch entry after restarting workbench so maps are rebuilt.',
    };
}
const transcriptMapHtml = _svPayload && _svPayload.reference_only
    ? buildSpliceVizHtml(_svPayload, { section: 'reference' })
    : '';
const spliceMapHtml = _svPayload && !_svPayload.reference_only
    ? buildSpliceVizHtml(_svPayload)
    : (_svPayload && _svPayload.eligible === false && _svPayload.reason
        ? buildSpliceVizHtml(_svPayload)
        : '');
let _jaPayload = res.parsed_data.junction_align_viz || null;
if (!_jaPayload && _isSpliceCtx) {
    _jaPayload = {
        eligible: false,
        reason: 'Junction sequence map not in this saved run — re-run the batch entry after restarting workbench.',
    };
}
const junctionAlignHtml = (typeof buildJunctionAlignLauncher === 'function' && _jaPayload)
    ? buildJunctionAlignLauncher(_jaPayload)
    : (_jaPayload && _jaPayload.eligible === false && _jaPayload.reason
        ? `<div style="width:100%;margin-top:10px;padding:8px 10px;font-size:0.8rem;color:#94a3b8;border-radius:6px;border:1px dashed rgba(255,255,255,0.12);">Junction map: ${String(_jaPayload.reason).replace(/</g, '&lt;')}</div>`
        : '');
const _truncBp = (s, maxLen) => {
    const t = String(s || '');
    return t.length <= maxLen ? t : t.slice(0, maxLen) + '…';
};
let junctionInsertHtml = '';
if (res.parsed_data.cryptic_inserted_cdna) {
    const _jIns = String(res.parsed_data.cryptic_inserted_cdna);
    const _jShow = _truncBp(_jIns, 20);
    const _jGain = res.parsed_data.cryptic_insert_triplet_decode
        ? `<div style="margin-top:6px;color:#d1fae5;font-size:0.9em;"><strong>Gain math:</strong> ${String(res.parsed_data.cryptic_insert_triplet_decode).replace(/</g, '&lt;')}</div>`
        : ' <span style="color:#94a3b8;">(see Logic / Cryptic for frame and PTC)</span>';
    junctionInsertHtml = `<div style="padding: 8px 12px; background: rgba(236, 253, 245, 0.06); border-radius: 4px; font-size: 0.85em; color: #a7f3d0; line-height: 1.4;"><strong style="color:#6ee7b7;">Junction insert (resolved cDNA):</strong> <code style="color:#ecfdf5;">${_jShow}</code> <span style="color:#94a3b8;">(${_jIns.length} bp${_jIns.length > 20 ? ', first 20 shown' : ''})</span>${_jGain}</div>`;
}
const nmdNarrativeOnly = stripNmdMathCatalogue(res.parsed_data.nmd_math);
const nmdNarrativeHtml = nmdNarrativeOnly
    ? `<div style="padding: 10px; background: rgba(255, 255, 255, 0.05); border-radius: 4px; font-size: 0.9em; color: #e2e8f0; line-height: 1.4;"><strong>Truncation &amp; NMD math:</strong> ${nmdNarrativeOnly}</div>`
    : '';
const noncodingCurationHtml = buildNoncodingCurationHtml(res.parsed_data);
const noncodingTrackPill = res.parsed_data.noncoding_track
    ? `<span class="data-pill" style="border-color:#38bdf8;background:rgba(14,165,233,0.12);color:#7dd3fc;">Track: <strong>Noncoding RNA (${esc((res.parsed_data.hgvs_dna_kind || 'n').toUpperCase())}.)</strong></span>`
    : '';
const panelHtml = `
<section class="eval-section">
  <h3 class="eval-section-title">Variant annotation</h3>
  <div class="eval-pill-row">
${noncodingTrackPill}
<span class="data-pill">Consequence: <strong>${esc(displayCsq)}</strong></span>
${(!res.parsed_data.noncoding_track && res.parsed_data.hgvs_p) ? `<span class="data-pill">p. Notation: <strong>${esc(res.parsed_data.hgvs_p)}</strong></span>` : ''}
<span class="data-pill">CADD: <strong>${res.parsed_data.cadd_phred}</strong></span>
<span class="data-pill">REVEL: <strong>${res.parsed_data.revel_score || 'N/A'}</strong></span>
<span class="data-pill">gnomAD AF: <strong>${res.parsed_data.gnomad_af != null ? Number(res.parsed_data.gnomad_af).toFixed(6) : 'N/A'}</strong></span>
${exonPill}
${nmdPill}
${truncPill}
${truncThresholdPill}
${inframePreservedPill}
  </div>
  ${transcriptMapHtml}
</section>
<section class="eval-section">
  <h3 class="eval-section-title eval-section-title--with-source">In silico splicing ${spliceInSilicoSourceLabel(res.parsed_data)}</h3>
  <div class="eval-spliceai-row">
${spliceaiPill}
  </div>
  <div class="eval-pangolin-row">
${pangolinPill}
  </div>
  <div class="eval-substack">
${res.parsed_data.spliceai_narrative ? `<div style="padding: 10px 12px; background: rgba(56, 189, 248, 0.08); border-radius: 4px; font-size: 0.9em; color: #e0f2fe; line-height: 1.45;"><strong style="color:#7dd3fc;">SpliceAI summary:</strong> ${res.parsed_data.spliceai_narrative.replace(/</g, '&lt;')}</div>` : ''}
${((res.parsed_data.spliceai_junction_model_preferred || res.parsed_data.spliceai_competing_splice_isoforms) && res.parsed_data.splice_model_interpretation) ? `<div style="padding: 10px 12px; background: rgba(16, 185, 129, 0.08); border-radius: 4px; font-size: 0.88em; color: #d1fae5; line-height: 1.45;"><strong style="color:#6ee7b7;">Splice model:</strong> ${String(res.parsed_data.splice_model_interpretation).replace(/</g, '&lt;')}</div>` : ''}
${junctionInsertHtml}
${(res.parsed_data.nmd_junction_model_truncation_fraction != null && res.parsed_data.nmd_junction_model_truncation_fraction !== undefined && !res.parsed_data.splice_suppress_parallel_junction_ui) ? `<div style="padding: 8px 12px; background: rgba(59, 130, 246, 0.08); border-radius: 4px; font-size: 0.85em; color: #dbeafe; line-height: 1.4;"><strong style="color:#93c5fd;">Cryptic junction isoform</strong> (acceptor/donor gain product): &approx; <strong>${(100 * res.parsed_data.nmd_junction_model_truncation_fraction).toFixed(1)}%</strong> C-term lost${res.parsed_data.junction_model_hgvs_p ? ` — ${res.parsed_data.junction_model_hgvs_p}` : ''}. <span style="color:#94a3b8;">Parallel to whole-exon skip when SpliceAI shows competing gain vs loss.</span></div>` : ''}
${res.parsed_data.splice_products_panel_html ? `<div style="padding: 10px 12px; background: rgba(255, 255, 255, 0.05); border-radius: 4px; font-size: 0.9em; color: #e2e8f0; line-height: 1.5;"><strong style="color:#93c5fd;">Splice products</strong> <span style="color:#94a3b8;font-size:0.82em;display:block;margin:4px 0 10px;">Each product uses the same field order: SpliceAI signal → geometry → frame → protein → PTC → length → NMD.</span>${res.parsed_data.splice_products_panel_html}</div>` : ''}
${!res.parsed_data.splice_products_panel_html && res.parsed_data.splice_frame_math ? `<div style="padding: 10px; background: rgba(255, 255, 255, 0.05); border-radius: 4px; font-size: 0.9em; color: #e2e8f0; line-height: 1.4;"><strong>Splice products:</strong> ${res.parsed_data.splice_frame_math}</div>` : ''}
${!res.parsed_data.splice_products_panel_html && res.parsed_data.spliceai_secondary_splice_frame_math ? `<div style="padding: 10px; background: rgba(251, 191, 36, 0.07); border-radius: 4px; font-size: 0.9em; color: #fef3c7; line-height: 1.45;"><strong style="color:#fcd34d;">Parallel whole-exon skip (second splice-site hypothesis)</strong>${res.parsed_data.spliceai_secondary_splice_frame_math}</div>` : ''}
${!res.parsed_data.splice_products_panel_html && res.parsed_data.deep_intronic_primary_splice_math ? `<div style="padding: 10px; background: rgba(16, 185, 129, 0.08); border-radius: 4px; font-size: 0.9em; color: #d1fae5; line-height: 1.45;"><strong style="color:#6ee7b7;">Splice products — primary</strong><div style="margin-top:8px;">${res.parsed_data.deep_intronic_primary_splice_math}</div></div>` : ''}
${!res.parsed_data.splice_products_panel_html && res.parsed_data.deep_intronic_alternate_splice_math ? `<div style="padding: 10px; background: rgba(251, 191, 36, 0.07); border-radius: 4px; font-size: 0.9em; color: #fef3c7; line-height: 1.45;"><strong style="color:#fcd34d;">Splice products — alternate</strong><div style="margin-top:8px;">${res.parsed_data.deep_intronic_alternate_splice_math}</div></div>` : ''}
${!res.parsed_data.splice_products_panel_html && res.parsed_data.deep_intronic_alternate2_splice_math ? `<div style="padding: 10px; background: rgba(251, 191, 36, 0.07); border-radius: 4px; font-size: 0.9em; color: #fef3c7; line-height: 1.45;"><strong style="color:#fcd34d;">Splice products — alternate (b)</strong><div style="margin-top:8px;">${res.parsed_data.deep_intronic_alternate2_splice_math}</div></div>` : ''}
${spliceMapHtml}
${junctionAlignHtml}
${res.parsed_data.splice_math_error ? `<div style="padding: 10px; background: rgba(245, 158, 11, 0.1); border-radius: 4px; font-size: 0.9em; color: #f59e0b; line-height: 1.4;"><strong>Splice Structural Math:</strong> ${res.parsed_data.splice_math_error}</div>` : ''}
  </div>
</section>
${(res.parsed_data.nmd_math || res.parsed_data.nmd_math_error || res.parsed_data.deep_intronic_splice_html) ? `
<section class="eval-section">
  <h3 class="eval-section-title">NMD & deep intronic context</h3>
  <div class="eval-substack">
${nmdNarrativeHtml}
${res.parsed_data.nmd_math_error ? `<div style="padding: 10px; background: rgba(245, 158, 11, 0.1); border-radius: 4px; font-size: 0.9em; color: #f59e0b; line-height: 1.4;"><strong>NMD Structural Math:</strong> ${res.parsed_data.nmd_math_error}</div>` : ''}
${res.parsed_data.deep_intronic_splice_html ? `<div style="padding: 10px; background: rgba(255, 255, 255, 0.05); border-radius: 4px; font-size: 0.9em; color: #e2e8f0; line-height: 1.45;"><strong>Deep intronic splice scan:</strong> ${res.parsed_data.deep_intronic_splice_html}</div>` : ''}
  </div>
</section>` : ''}
${noncodingCurationHtml}
<section class="eval-section">
  <h3 class="eval-section-title">ClinVar, HGMD & external links</h3>
  <div class="eval-pill-row">
<span class="data-pill">ClinVar: <strong>
    ${res.parsed_data.clinvar_rcv ? `<a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${res.parsed_data.clinvar_rcv}/" target="_blank" style="color:var(--primary); text-decoration:underline;">${res.parsed_data.clinvar_sig || 'Link'}</a>` : `<a href="${res.parsed_data.clinvar_search_link || res.parsed_data.c_allele_search_link || '#'}" target="_blank" style="color:var(--text-muted); text-decoration:underline;">Search</a>`}
</strong></span>
${hgmdBadge}
${clingenPill}
${grPill}
${(!res.parsed_data.noncoding_track && res.parsed_data.uniprot_link) ? `<span class="data-pill">UniProt: <strong><a href="${res.parsed_data.uniprot_link}" target="_blank" style="color:var(--primary); text-decoration:underline;">View Target</a></strong></span>` : ''}
${(() => {
  const md = res.parsed_data;
  if (md.noncoding_track || !md.metadome_checked || md.metadome_status === 'skipped') return '';
  const href = esc(md.metadome_link || 'https://stuart.radboudumc.nl/metadome/');
  if (md.metadome_status === 'ready' && md.metadome_summary) {
    const intolerant = md.metadome_intolerant;
    const border = intolerant ? '#fca5a5' : '#7dd3fc';
    const bg = intolerant ? 'rgba(239,68,68,0.1)' : 'rgba(14,165,233,0.1)';
    const color = intolerant ? '#fca5a5' : '#7dd3fc';
    return `<span class="data-pill" style="border-color:${border};background:${bg};color:${color};">MetaDome: <strong>${esc(md.metadome_summary)}</strong> <a href="${href}" target="_blank" style="color:${color};text-decoration:underline;">Open</a></span>`;
  }
  if (md.metadome_status === 'processing') {
    return `<span class="data-pill" style="border-color:#fbbf24;background:rgba(251,191,36,0.1);color:#fbbf24;">MetaDome: <strong>building…</strong> <a href="${href}" target="_blank" style="color:#fbbf24;text-decoration:underline;">Open</a></span>`;
  }
  if (md.metadome_link) {
    return `<span class="data-pill">MetaDome: <strong><a href="${href}" target="_blank" style="color:var(--primary);text-decoration:underline;">Open</a></strong>${md.metadome_error ? ` <span style="opacity:0.75;">(${esc(md.metadome_error)})</span>` : ''}</span>`;
  }
  return '';
})()}
<span class="data-pill">Google Scholar: <strong><a href="${res.parsed_data.google_scholar_link}" target="_blank" style="color:var(--primary); text-decoration:underline;">Search</a></strong></span>
  </div>
</section>
<section class="eval-section">
  <h3 class="eval-section-title">Allele context, automation & literature status</h3>
  <div class="eval-allele-stack">
${clinvarScanPill}
${exonicFsPrimaryPill}
${altPill}
${pm5LocalPill}
${hotspotPill}
${autoPill}
${skippedExonPill}
${domainPill}
${litPill}${mechanismAlertPill}
  </div>
</section>
${literatureIndexHtml}
${(res.parsed_data && res.parsed_data.clinical_publication_summary_html) ? `<section class="eval-section" style="border-color: rgba(251, 191, 36, 0.35); background: rgba(251, 191, 36, 0.06);"><h3 class="eval-section-title" style="color:#fcd34d;border-bottom-color: rgba(251,191,36,0.25);">Clinical summary (for reports)</h3><div style="font-size: 0.95em;">${res.parsed_data.clinical_publication_summary_html}</div></section>` : ''}
${(res.literature && res.literature.clinical_summary) ? literatureReviewSection('Clinical Literature Review', '#c084fc', 'rgba(192, 132, 252, 0.35)', 'rgba(139, 92, 246, 0.08)', res.literature.clinical_summary, clinicalLiteratureSpecHtml()) : (res.literature && res.literature.clinical_error ? `<section class="eval-section"><p class="banner warn">Literature clinical summary: ${esc(res.literature.clinical_error)}</p></section>` : '')}
${(res.literature && res.literature.functional_summary) ? literatureReviewSection('Functional Studies Review', '#34d399', 'rgba(16, 185, 129, 0.35)', 'rgba(16, 185, 129, 0.06)', res.literature.functional_summary, '') : ''}
${res.parsed_data.logic_explanation ? `<section class="eval-section" style="border-color: rgba(16, 185, 129, 0.25); background: rgba(16, 185, 129, 0.04);"><h3 class="eval-section-title" style="color:#34d399;border-bottom-color: rgba(16,185,129,0.2);">Logic explanation</h3><div style="font-size: 0.95em; color: #e2e8f0; line-height: 1.5;">${res.parsed_data.logic_explanation}</div></section>` : ''}
      `;
    return {
      html: panelHtml,
      copyText: buildReviewCopyText(res, { csq, displayCsq }),
    };
  }

  function buildReviewCopyText(res, ctx) {
    if (typeof CopyPasteBuilder !== 'undefined' && CopyPasteBuilder.buildCopyPasteText) {
      return CopyPasteBuilder.buildCopyPasteText(res, ctx);
    }
    const pd = res.parsed_data || {};
    const displayCsq = ctx.displayCsq || ctx.csq || '';
    if (pd.logic_explanation_plaintext) return String(pd.logic_explanation_plaintext).trim();
    return 'Consequence: ' + displayCsq;
  }

  global.ClassifierParsedPanel = { renderClassifierParsedPanel, stripHtmlForCopy, buildReviewCopyText };
})(typeof window !== 'undefined' ? window : this);
