/* Junction / splice map HTML for the workbench review page */
/*
 * Splice exon map — unified rendering rules (all variants):
 *   Reference → optional isoform rows in row_order.
 *   Skip row: target exon striped (loss / whole-exon skip).
 *   Gain row: same dual-track builder always; anchor exon kept; pseudo-exon when
 *     pseudoexon_retained_nt or shift_nt > 0; labels only change (primary/secondary/competing).
 *   Skip2 row: parallel whole-exon skip on secondary_target_rank (yellow).
 *   Deep intronic may use dedicated schematics — same product slots, different drawer.
 */
function buildSpliceVizHtml(sv, opts) {
    opts = opts || {};
    const section = opts.section || 'full';
    if (!sv) return '';
    if (sv.eligible === false) {
        if (section === 'isoforms') return '';
        return '<div style="width:100%; flex-basis:100%; margin-top:10px; padding:8px 10px; font-size:0.8rem; color:var(--sv-muted,#94a3b8); border-radius:6px; border:1px dashed var(--line,rgba(255,255,255,0.12));">'
            + 'Transcript exon map: ' + String(sv.reason || 'unavailable').replace(/</g, '&lt;') + '</div>';
    }
    const showReference = section === 'full' || section === 'reference';
    const showIsoforms = (section === 'full' || section === 'isoforms') && sv.reference_only !== true;
    if (section === 'isoforms' && sv.reference_only === true) return '';
    if (!showReference && !showIsoforms) return '';
    const exFull = (sv.exons_full && sv.exons_full.length) ? sv.exons_full : (sv.exons || []);
    const fp = sv.focus_primary || { exons: sv.exons || [], trunc_before: sv.truncated_before || 0, trunc_after: sv.truncated_after || 0 };
    const fj = sv.focus_junction || fp;
    const fs = sv.focus_secondary;
    if (!exFull.length && (showIsoforms ? !(fp.exons && fp.exons.length) : true)) return '';
    const T = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const target = (sv.target_rank != null && !isNaN(parseInt(sv.target_rank, 10))) ? parseInt(sv.target_rank, 10) : null;
    const ro = sv.row_order || 'ref_skip';
    const suppressSkip = sv.suppress_whole_exon_skip_row === true;
    const secTarget = (sv.secondary_target_rank != null && !isNaN(parseInt(sv.secondary_target_rank, 10)))
        ? parseInt(sv.secondary_target_rank, 10) : null;
    const secMech = (sv.secondary_mechanism && String(sv.secondary_mechanism)) || (secTarget != null ? '5prime_donor_loss' : '');
    const vm = sv.variant_marker || null;
    const hgvsViz = (sv.hgvs_c_for_viz || '').trim();

    const hgvsTip = (suffix) => {
        const s = suffix ? String(suffix) : '';
        if (hgvsViz) return T('Variant (HGVS ' + hgvsViz + ')' + (s ? '. ' + s : ''));
        return T(s || 'Variant locus (schematic)');
    };

    const metBadgeHtml = (rank, cfg) => {
        const metRank = (cfg && cfg.startCodonExonRank != null) ? parseInt(cfg.startCodonExonRank, 10) : null;
        if (metRank == null || isNaN(metRank) || parseInt(rank, 10) !== metRank) return '';
        const tip = T('Start codon (AUG) — original Met; UTR pseudo-exon insert is upstream and does not introduce a new Met.');
        return '<span style="position:absolute;left:6px;top:2px;font-size:0.48rem;font-weight:800;color:#fde68a;line-height:1;'
            + 'text-shadow:0 0 6px rgba(253,224,106,0.45);z-index:2;" title="' + tip + '">Met</span>';
    };

    const variantExonMarkHtml = (rank, lenHint) => {
        if (!vm || vm.mode !== 'exon' || parseInt(vm.exon_rank, 10) !== parseInt(rank, 10)) return '';
        let frac = 0.5;
        if (vm.fraction_in_exon != null) {
            const raw = parseFloat(vm.fraction_in_exon);
            if (!isNaN(raw)) frac = Math.min(0.97, Math.max(0.03, raw));
        }
        const tip = hgvsTip('Variant position within exon ' + rank + (lenHint ? ' (' + lenHint + ' coding bp in this box)' : '') + '.');
        return '<span style="position:absolute;left:' + (frac * 100) + '%;top:3px;bottom:3px;width:2px;margin-left:-1px;background:#fbbf24;border-radius:1px;box-shadow:0 0 8px rgba(251,191,36,0.65);z-index:2;" title="' + tip + '"></span>'
            + '<span style="position:absolute;left:' + (frac * 100) + '%;top:-9px;transform:translateX(-50%);color:#fbbf24;font-size:12px;line-height:1;text-shadow:0 0 8px rgba(251,191,36,0.55);z-index:3;" title="' + tip + '">\u25C6</span>';
    };

    const buildEllipsis = (n, side) => {
        if (!n || n <= 0) return '';
        const lbl = '+' + n + ' exon' + (n === 1 ? '' : 's');
        const tip = 'More exons ' + (side === 'lo' ? 'upstream (5\u2032)' : 'downstream (3\u2032)') + ' — hidden in this zoomed row.';
        const st = 'background: repeating-linear-gradient(135deg, rgba(148,163,184,0.18), rgba(148,163,184,0.18) 3px, rgba(20,20,30,0.35) 3px, rgba(20,20,30,0.35) 6px); border: 1px dashed rgba(148,163,184,0.45);';
        return '<div style="flex:0 0 44px; min-height:30px; border-radius:3px; display:flex; align-items:center; justify-content:center; ' + st + '" title="' + T(tip) + '"><span style="font-size:0.58rem; font-weight:600; color:#cbd5e1;">' + (side === 'lo' ? '\u2026 ' + lbl : lbl + ' \u2026') + '</span></div>';
    };

    const SV_EXON_MIN = 44;
    const SV_INTRON_MIN = 56;

    const svExonFlexWeight = (e, arr) => {
        const n = parseInt(e.len_bp, 10);
        if (!isNaN(n) && n > 0) return n;
        const len = (arr || []).length || 1;
        return Math.max(40, Math.round(400 / len));
    };

    const svPseudoWidthPx = (nt) => {
        const n = parseInt(nt, 10);
        if (isNaN(n) || n <= 0) return 100;
        return Math.max(100, Math.min(320, Math.round(n * 0.85)));
    };

    const svExonStyle = (mode, rank, cfg) => {
        const r = parseInt(rank, 10);
        const target = cfg.targetRank;
        const skipRank = cfg.skipRank;
        const skip2Rank = cfg.skip2Rank;
        let st = 'background:#1e7386;border:1px solid #3db0c7;';
        let tip = 'Exon ' + r + ' \u2014 ' + (cfg.lenBp || '') + ' coding bp';
        if ((mode === 'skip' || mode === 'skip-pre') && skipRank != null && r === skipRank) {
            st = 'background:repeating-linear-gradient(135deg,rgba(244,63,94,0.22),rgba(244,63,94,0.22) 4px,rgba(20,20,30,0.4) 4px,rgba(20,20,30,0.4) 8px);border:1px dashed #f43f5e;opacity:0.85;';
            tip = 'Exon ' + r + ' \u2014 removed by whole-exon skip in this isoform';
        }
        if ((mode === 'skip2' || mode === 'skip2-pre') && skip2Rank != null && r === skip2Rank) {
            st = 'background:repeating-linear-gradient(135deg,rgba(251,191,36,0.22),rgba(251,191,36,0.22) 4px,rgba(20,20,30,0.4) 4px,rgba(20,20,30,0.4) 8px);border:1px dashed #fbbf24;';
            tip = 'Alternate whole-exon skip \u2014 exon ' + r + ' removed';
        }
        if (mode === 'jun-pre' && target != null && r === target) {
            const pseudoUpstream = cfg.pseudoAfterRank != null && cfg.pseudoNt
                && parseInt(cfg.pseudoAfterRank, 10) < parseInt(target, 10);
            if (!pseudoUpstream) {
                st = 'background:rgba(16,185,129,0.18);border:1px solid #34d399;';
                tip = 'Anchor exon ' + r + ' (donor/acceptor gain junction)';
            }
        }
        if (cfg.utrExonRank != null && parseInt(cfg.utrExonRank, 10) === r) {
            st = 'background:rgba(56,189,248,0.14);border:1px solid rgba(125,211,252,0.55);';
            tip = 'Exon ' + r + ' \u2014 5\u2032 UTR (non-coding)';
        }
        if (mode === 'jun-pre' && target != null && r !== target) {
            st = 'background:rgba(100,116,139,0.12);border:1px solid rgba(148,163,184,0.3);opacity:0.92;';
        }
        // Exon-internal cryptic gain — half the variant exon survives splicing,
        // the other half is excised. Render the box explicitly as kept (green
        // tint) on one side and spliced-out (red diagonal stripes) on the
        // other, so an exon-internal cryptic donor like NLRP3 c.2798G>T no
        // longer reads as a full-length E8 in the mRNA strip.
        if (cfg.exonInternalCutRank != null
                && parseInt(cfg.exonInternalCutRank, 10) === r
                && cfg.exonInternalCutFraction != null
                && cfg.exonInternalCutSide) {
            const cutFrac = Math.max(0, Math.min(1, parseFloat(cfg.exonInternalCutFraction)));
            const cutPct = (cutFrac * 100).toFixed(2);
            const skipStripe = 'repeating-linear-gradient(135deg,rgba(244,63,94,0.30),rgba(244,63,94,0.30) 4px,rgba(20,20,30,0.45) 4px,rgba(20,20,30,0.45) 8px)';
            const keptTint = 'rgba(16,185,129,0.22)';
            const onMrna = (mode === 'jun' || mode === 'mrna');
            // Pre-mRNA: cut line as a faint cue only — pre-mRNA still contains
            // the whole exon, so don't shade either half there.
            // mRNA: shade the spliced-out side with the red stripe pattern.
            let bg = keptTint;
            if (onMrna) {
                if (cfg.exonInternalCutSide === 'donor') {
                    // 3' tail of the exon is excised.
                    bg = 'linear-gradient(90deg,' + keptTint + ' 0 ' + cutPct + '%,transparent ' + cutPct + '% 100%),' + skipStripe;
                } else if (cfg.exonInternalCutSide === 'acceptor') {
                    // 5' head of the exon is excised.
                    bg = skipStripe + ',linear-gradient(90deg,transparent 0 ' + cutPct + '%,' + keptTint + ' ' + cutPct + '% 100%)';
                }
            }
            st = 'background:' + bg + ';background-size:100% 100%;border:1px solid #34d399;';
            tip = onMrna
                ? ('E' + r + ' truncated at cryptic ' + (cfg.exonInternalCutSide === 'donor' ? 'donor' : 'acceptor')
                    + ' (~' + Math.round(cutFrac * 100) + '% along exon); shaded side is spliced out.')
                : ('E' + r + ' contains a cryptic ' + (cfg.exonInternalCutSide === 'donor' ? 'donor (GT)' : 'acceptor (AG)')
                    + ' at ~' + Math.round(cutFrac * 100) + '%. Pre-mRNA still has the full exon.');
        }
        return { st: st, tip: tip };
    };

    const svPseudoBoxHtml = (nt, accent, withPtc, ptcFrac, ptcHgvs) => {
        const ntStr = (nt != null && !isNaN(parseInt(nt, 10))) ? String(parseInt(nt, 10)) : '?';
        const isUtr = withPtc === 'utr';
        const col = accent === 'amber' ? '#fde68a' : (isUtr ? '#7dd3fc' : '#6ee7b7');
        const bd = accent === 'amber' ? '#fbbf24' : (isUtr ? '#38bdf8' : '#34d399');
        const w = svPseudoWidthPx(nt);
        const fracUse = (!isUtr && withPtc && ptcFrac != null && !isNaN(parseFloat(ptcFrac)))
            ? parseFloat(ptcFrac)
            : (!isUtr && withPtc ? 0.5 : null);
        const terTick = (fracUse != null)
            ? ('<span style="position:absolute;left:' + (fracUse * 100) + '%;top:3px;bottom:3px;width:2px;margin-left:-1px;background:#f87171;border-radius:1px;"></span>'
                + '<span style="position:absolute;bottom:1px;left:' + (fracUse * 100) + '%;transform:translateX(-50%);font-size:0.46rem;font-weight:800;color:#fca5a5;">Ter</span>')
            : '';
        const hgvsTip = (ptcHgvs || '').trim();
        const boxTip = isUtr
            ? (ntStr + ' nt 5\u2032 UTR insert (pre-AUG) \u2014 annotated ORF unchanged')
            : (ntStr + ' nt pseudo-exon retained in mature mRNA'
                + (withPtc ? ('; PTC ' + (hgvsTip || 'in pseudo-exon') + (fracUse != null ? (' (~' + Math.round(fracUse * 100) + '% along box)') : '')) : ''));
        const subLbl = isUtr ? '5\u2032 UTR' : 'pseudo-exon';
        return '<div style="position:relative;flex:0 0 ' + w + 'px;min-width:' + w + 'px;min-height:34px;border-radius:4px;border:2px dashed ' + bd + ';background:rgba(16,185,129,0.1);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2px 4px;box-sizing:border-box;" title="' + T(boxTip) + '">'
            + terTick
            + '<span style="font-size:0.58rem;font-weight:700;color:' + col + ';line-height:1.1;">+' + T(ntStr) + ' nt</span>'
            + '<span style="font-size:0.46rem;color:var(--sv-muted,#94a3b8);">' + subLbl + '</span>'
            + (withPtc && !isUtr ? '<span style="font-size:0.46rem;color:#fca5a5;">PTC</span>' : '')
            + '</div>';
    };

    const svIntronGeneHtml = (leftRank, rightRank, opts) => {
        opts = opts || {};
        const isVar = opts.isVariant;
        const pseudo = opts.pseudoInIntron;
        if (pseudo && pseudo.nt) {
            const w = Math.max(SV_INTRON_MIN, svPseudoWidthPx(pseudo.nt) + 32);
            const five = T(pseudo.fiveLbl || 'GT');
            const three = T(pseudo.threeLbl || 'AG');
            return '<div style="flex:2 1 0;min-width:' + w + 'px;position:relative;display:flex;align-items:center;height:34px;margin:0 1px;" title="' + T('Intron E' + leftRank + '\u2013E' + rightRank + ': pseudo-exon created by cryptic splice sites') + '">'
                + '<div style="flex:1;height:2px;background:linear-gradient(90deg,#475569,#64748b);min-width:4px;"></div>'
                + '<div style="flex:0 0 auto;display:flex;align-items:center;gap:3px;border:1px dashed #34d399;border-radius:4px;background:rgba(16,185,129,0.07);padding:3px 5px;">'
                + '<span style="font-size:0.46rem;font-weight:800;color:#fbbf24;font-family:ui-monospace,monospace;">' + five + '</span>'
                + '<span style="font-size:0.5rem;font-weight:700;color:#6ee7b7;">' + T(String(pseudo.nt)) + 'nt</span>'
                + '<span style="font-size:0.46rem;font-weight:800;color:#fdba74;font-family:ui-monospace,monospace;">' + three + '</span>'
                + '</div>'
                + '<div style="flex:1;height:2px;background:linear-gradient(90deg,#64748b,#475569);min-width:4px;"></div>'
                + (isVar ? '<span style="position:absolute;top:-14px;left:50%;transform:translateX(-50%);color:#fbbf24;font-size:10px;">\u25C6</span>' : '')
                + '</div>';
        }
        const tip = isVar
            ? hgvsTip('Intron between E' + leftRank + ' and E' + rightRank + '.')
            : T('Intron between E' + leftRank + ' and E' + rightRank);
        const varMark = isVar
            ? ('<span style="position:absolute;top:-13px;left:50%;transform:translateX(-50%);color:#fbbf24;font-size:11px;line-height:1;text-shadow:0 0 8px rgba(251,191,36,0.65);z-index:4;">\u25C6</span>')
            : '';
        return '<div style="flex:1 1 0;min-width:28px;display:flex;align-items:center;justify-content:center;height:34px;margin:0 1px;position:relative;" title="' + tip + '">'
            + '<div style="width:100%;height:2px;background:#475569;border-radius:1px;"></div>'
            + varMark
            + '</div>';
    };

    const vmIntronMatches = (leftRank, rightRank) => {
        if (!vm || vm.mode !== 'intron') return false;
        const up = parseInt(vm.upstream_exon, 10);
        const dn = parseInt(vm.downstream_exon, 10);
        const l = parseInt(leftRank, 10);
        const r = parseInt(rightRank, 10);
        if (isNaN(up) || isNaN(dn) || isNaN(l) || isNaN(r)) return false;
        return up === l && dn === r;
    };

    const buildGeneOrMrnaTrack = (exonArr, truncBefore, truncAfter, cfg) => {
        const arr = exonArr || [];
        const tb = parseInt(truncBefore || 0, 10) || 0;
        const ta = parseInt(truncAfter || 0, 10) || 0;
        const mode = cfg.trackMode || 'pre-mrna';
        const isMrna = mode === 'mrna';
        const styleMode = cfg.styleMode || (isMrna ? 'skip' : 'skip-pre');
        const skipRank = cfg.skipRank;
        const skip2Rank = cfg.skip2Rank;
        const useSkip2 = styleMode.indexOf('skip2') >= 0;
        const sk = useSkip2 ? skip2Rank : skipRank;
        const minPx = SV_EXON_MIN;
        const parts = [];
        let variantIntronPlaced = false;
        parts.push(buildEllipsis(tb, 'lo'));
        if (!isMrna && cfg.isReference && vm && vm.mode === 'intron' && vm.upstream_exon == null && vm.downstream_exon != null
                && arr.length && parseInt(arr[0].rank, 10) === parseInt(vm.downstream_exon, 10)) {
            parts.push(variantIntronHtml(null, vm.downstream_exon));
        }
        for (let i = 0; i < arr.length; i++) {
            const e = arr[i];
            const r = parseInt(e.rank, 10);
            const flexW = svExonFlexWeight(e, arr);
            if (isMrna && sk != null && r === sk) continue;
            const es = svExonStyle(styleMode, r, {
                targetRank: cfg.targetRank,
                skipRank: skipRank,
                skip2Rank: skip2Rank,
                lenBp: e.len_bp,
                exonInternalCutRank: cfg.exonInternalCutRank,
                exonInternalCutFraction: cfg.exonInternalCutFraction,
                exonInternalCutSide: cfg.exonInternalCutSide,
            });
            const ptcHit = (cfg.ptcList || []).find(function (p) { return parseInt(p.exon_rank, 10) === r; });
            let ptcLine = '';
            let ptcBadge = '';
            if (ptcHit && isMrna) {
                let ptcFrac = 0.5;
                if (ptcHit.fraction_in_exon != null) {
                    const raw = parseFloat(ptcHit.fraction_in_exon);
                    if (!isNaN(raw)) ptcFrac = Math.min(0.97, Math.max(0.03, raw));
                }
                ptcLine = '<span style="position:absolute;left:' + (ptcFrac * 100) + '%;top:4px;bottom:14px;width:2px;margin-left:-1px;background:#f87171;border-radius:1px;z-index:1;"></span>';
                ptcBadge = '<span style="position:absolute;bottom:2px;left:' + (ptcFrac * 100) + '%;transform:translateX(-50%);font-size:0.48rem;font-weight:800;color:#fca5a5;line-height:1;white-space:nowrap;z-index:2;">Ter</span>';
            }
            const showExonVar = vm && vm.mode === 'exon' && parseInt(vm.exon_rank, 10) === r;
            const exonVarMark = showExonVar ? variantExonMarkHtml(r, e.len_bp) : '';
            const fadeDown = cfg.fadeAfterRank != null && r > cfg.fadeAfterRank;
            const boxSt = es.st + (fadeDown ? 'opacity:0.35;filter:saturate(0.5);' : '');
            const exonFlex = 'flex:' + flexW + ' 1 0;min-width:' + minPx + 'px;';
            // Cryptic cut-site tick on the variant exon's box — the dashed
            // amber line marks where the cryptic GT / AG falls inside the
            // exon. Drawn on both pre-mRNA (informational) and mRNA (border
            // between kept and excised halves) tracks.
            let exonCutTick = '';
            if (cfg.exonInternalCutRank != null
                    && parseInt(cfg.exonInternalCutRank, 10) === r
                    && cfg.exonInternalCutFraction != null
                    && cfg.exonInternalCutSide) {
                const cutFrac = Math.max(0, Math.min(1, parseFloat(cfg.exonInternalCutFraction)));
                const cutPct = (cutFrac * 100).toFixed(2);
                const cutLbl = cfg.exonInternalCutSide === 'donor' ? 'cryptic GT (donor)' : 'cryptic AG (acceptor)';
                exonCutTick =
                    '<span style="position:absolute;left:' + cutPct + '%;top:-2px;bottom:-2px;width:0;'
                    + 'border-left:2px dashed #fbbf24;margin-left:-1px;pointer-events:none;z-index:3;"'
                    + ' title="' + T(cutLbl + ' inside E' + r + ' \u2014 the shaded side is spliced out') + '"></span>';
            }
            parts.push('<div style="position:relative;' + exonFlex + 'min-height:34px;border-radius:4px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;' + (ptcHit ? 'padding-bottom:12px;' : '') + boxSt + '" title="' + T(es.tip) + '">' + exonVarMark + ptcLine + exonCutTick + metBadgeHtml(r, cfg) + '<span style="font-size:0.65rem;font-weight:600;color:#e2e8f0;">E' + r + '</span>' + ptcBadge + '</div>');
            if (isMrna && cfg.pseudoAfterRank != null && r === cfg.pseudoAfterRank && cfg.pseudoNt) {
                const ptcArg = cfg.pseudoPtcMode === 'utr' ? 'utr' : cfg.pseudoPtc;
                parts.push(svPseudoBoxHtml(cfg.pseudoNt, cfg.pseudoAccent, ptcArg, cfg.pseudoPtcFrac, cfg.pseudoPtcHgvs));
            }
            if (!isMrna && i < arr.length - 1) {
                const nextR = parseInt(arr[i + 1].rank, 10);
                const isVar = vmIntronMatches(r, nextR);
                if (isVar) variantIntronPlaced = true;
                let pseudoIn = null;
                if (cfg.pseudoAfterRank != null && r === cfg.pseudoAfterRank && cfg.pseudoNt) {
                    pseudoIn = {
                        nt: cfg.pseudoNt,
                        fiveLbl: cfg.pseudoFiveLbl || 'GT',
                        threeLbl: cfg.pseudoThreeLbl || 'AG',
                    };
                }
                if (cfg.isReference && isVar) {
                    parts.push(variantIntronHtml(r, nextR));
                } else {
                    parts.push(svIntronGeneHtml(r, nextR, { isVariant: isVar, pseudoInIntron: pseudoIn }));
                }
            }
        }
        parts.push(buildEllipsis(ta, 'hi'));
        const bodyCls = isMrna ? 'splice-track-body' : 'splice-track-body';
        return '<div class="' + bodyCls + '">' + parts.join('') + '</div>';
    };

    const buildDualTrackIsoform = (exonArr, truncBefore, truncAfter, cfg) => {
        cfg = cfg || {};
        const preCfg = Object.assign({}, cfg, { trackMode: 'pre-mrna', styleMode: cfg.preStyleMode || cfg.styleMode || 'skip-pre' });
        const mrnaCfg = Object.assign({}, cfg, { trackMode: 'mrna', styleMode: cfg.mrnaStyleMode || cfg.styleMode || 'skip' });
        const pre = buildGeneOrMrnaTrack(exonArr, truncBefore, truncAfter, preCfg);
        const mrna = buildGeneOrMrnaTrack(exonArr, truncBefore, truncAfter, mrnaCfg);
        return '<div class="splice-isoform-panel splice-track-scroll">'
            + '<div class="splice-track-row"><span class="splice-track-tag">Pre-mRNA</span>' + pre + '</div>'
            + '<div class="splice-track-row"><span class="splice-track-tag">mRNA</span>' + mrna + '</div>'
            + '</div>';
    };

    const buildReferenceGeneTrack = (exonArr, truncBefore, truncAfter, opts) => {
        opts = opts || {};
        const ptcList = opts.ptcList || [];
        const hasPtc = ptcList.length > 0;
        const refCfg = {
            trackMode: 'pre-mrna',
            styleMode: 'ref-pre',
            isReference: true,
            startCodonExonRank: opts.startCodonExonRank,
            utrExonRank: opts.utrExonRank,
        };
        const pre = buildGeneOrMrnaTrack(exonArr, truncBefore || 0, truncAfter || 0, refCfg);
        let rows = '<div class="splice-track-row splice-reference-track-row"><span class="splice-track-tag">Gene</span>' + pre + '</div>';
        if (hasPtc) {
            const mrna = buildGeneOrMrnaTrack(exonArr, truncBefore || 0, truncAfter || 0, {
                trackMode: 'mrna',
                styleMode: 'ref-mrna',
                ptcList: ptcList,
                fadeAfterRank: opts.fadeAfterRank,
            });
            rows += '<div class="splice-track-row"><span class="splice-track-tag">Mutant mRNA</span>' + mrna + '</div>';
        }
        return '<div class="splice-isoform-panel splice-track-scroll splice-reference-track">' + rows + '</div>';
    };

    const spliceMapSection = (labelHtml, bodyHtml, ptcLocHtml) => {
        const cap = ptcLocHtml
            ? ('<div style="font-size:0.58rem;color:#fca5a5;margin-top:6px;line-height:1.45;padding-left:2px;">' + ptcLocHtml + '</div>')
            : '';
        return '<div class="splice-map-section">'
            + '<div class="splice-map-section-label">' + labelHtml + '</div>'
            + bodyHtml
            + cap
            + '</div>';
    };

    const formatPtcLocLine = (kind, label, detail, hgvs) => {
        if (!label && !hgvs) return '';
        let s = '<strong style="color:#fca5a5;">PTC location:</strong> ';
        if (kind === 'pseudo_exon') {
            s += '<span style="color:#fde68a;">' + T(label) + '</span>';
        } else if (kind === 'coding_exon') {
            s += '<span style="color:#fca5a5;">' + T(label) + '</span>';
        } else {
            s += '<span style="color:var(--sv-ink,#e2e8f0);">' + T(label || 'see protein line above') + '</span>';
        }
        if (detail) {
            s += ' <span style="color:var(--sv-muted,#94a3b8);">(' + T(detail) + ')</span>';
        }
        if (hgvs) {
            s += ' — <span style="color:var(--sv-ink,#e2e8f0);">' + T(hgvs) + '</span>';
        }
        s += ' <span style="color:#64748b;">— Ter marker on map shows position.</span>';
        return s;
    };

    const ptcLocFromSv = (kindKey, labelKey, detailKey, hgvs) => {
        const kind = sv[kindKey] || null;
        const label = sv[labelKey] || null;
        const detail = sv[detailKey] || null;
        if (!label && !hgvs) return '';
        return formatPtcLocLine(kind, label, detail, hgvs);
    };

    const ptcLocFromAlt = (alt) => {
        if (!alt) return '';
        const hgvs = (alt.ptc_hgvs || '').trim();
        if (alt.ptc_location_label) {
            return formatPtcLocLine(alt.ptc_location_kind || null, alt.ptc_location_label, alt.ptc_location_detail, hgvs);
        }
        if (alt.ptc_within_insert && hgvs) {
            return formatPtcLocLine('pseudo_exon', 'retained pseudo-exon', alt.ptc_frac_in_insert != null ? ('~' + Math.round(parseFloat(alt.ptc_frac_in_insert) * 100) + '% along pseudo-exon box') : null, hgvs);
        }
        if (alt.downstream_exon_rank && hgvs) {
            return formatPtcLocLine('pseudo_exon', 'retained pseudo-exon between exon ' + alt.anchor_exon_rank + ' and exon ' + alt.downstream_exon_rank, null, hgvs);
        }
        return hgvs ? formatPtcLocLine(null, null, null, hgvs) : '';
    };

    const ptcLocFromLayer = (layer, kind) => {
        if (!layer || layer.exon_rank == null) return '';
        const er = parseInt(layer.exon_rank, 10);
        if (isNaN(er) || er < 1) return '';
        let detail = null;
        if (layer.fraction_in_exon != null) {
            const f = parseFloat(layer.fraction_in_exon);
            if (!isNaN(f)) detail = '~' + Math.round(f * 100) + '% along exon ' + er + ' box';
        }
        return formatPtcLocLine(kind || 'coding_exon', 'native coding exon ' + er, detail, layer.hgvs_p || '');
    };

    const focusWindowFromFull = (exonsFull, centerRank, neighbor) => {
        neighbor = (neighbor != null && !isNaN(parseInt(neighbor, 10))) ? parseInt(neighbor, 10) : 2;
        if (!exonsFull || !exonsFull.length || centerRank == null) {
            return { exons: [], trunc_before: 0, trunc_after: 0 };
        }
        const cr = parseInt(centerRank, 10);
        if (isNaN(cr) || cr < 1) return { exons: [], trunc_before: 0, trunc_after: 0 };
        const ranks = exonsFull.map(function (e) { return parseInt(e.rank, 10); });
        const rmin = Math.min.apply(null, ranks);
        const rmax = Math.max.apply(null, ranks);
        const lo = Math.max(rmin, cr - neighbor);
        const hi = Math.min(rmax, cr + neighbor);
        const subset = exonsFull.filter(function (e) {
            const r = parseInt(e.rank, 10);
            return r >= lo && r <= hi;
        }).sort(function (a, b) { return parseInt(a.rank, 10) - parseInt(b.rank, 10); });
        const trunc_before = exonsFull.filter(function (e) { return parseInt(e.rank, 10) < lo; }).length;
        const trunc_after = exonsFull.filter(function (e) { return parseInt(e.rank, 10) > hi; }).length;
        const bp = subset.reduce(function (s, e) { return s + (parseInt(e.len_bp, 10) || 0); }, 0) || 1;
        const exons = subset.map(function (e) {
            const len = parseInt(e.len_bp, 10) || 0;
            return {
                rank: parseInt(e.rank, 10),
                len_bp: len,
                w: Math.max(0.02, len / bp),
            };
        });
        return { exons: exons, trunc_before: trunc_before, trunc_after: trunc_after };
    };

    const ptcExonInWindow = (exonArr, layer) => {
        if (!layer || layer.exon_rank == null || !exonArr || !exonArr.length) return false;
        const er = parseInt(layer.exon_rank, 10);
        if (isNaN(er) || er < 1) return false;
        return exonArr.some(function (e) { return parseInt(e.rank, 10) === er; });
    };

    const buildPtcLocationMapRow = (layer, productLabel, visibleExonArr) => {
        if (!layer || layer.exon_rank == null || layer.exon_rank === '') return '';
        const er = parseInt(layer.exon_rank, 10);
        if (isNaN(er) || er < 1) return '';
        if (visibleExonArr && ptcExonInWindow(visibleExonArr, layer)) return '';
        const pw = focusWindowFromFull(exFull, er, 2);
        if (!pw.exons.length) return '';
        const zoomLbl = ' <span style="color:#64748b;font-size:0.62rem;">(zoomed \u00b12 exons around E' + er + ')</span>';
        const sub = productLabel
            ? ('<span style="color:var(--sv-muted,#94a3b8);font-size:0.65rem;font-weight:500;">' + T(productLabel) + '</span>')
            : '';
        return spliceMapSection(
            '<span style="color:#fca5a5;">Novel stop (PTC)</span>' + (sub ? ' \u2014 ' + sub : '') + zoomLbl,
            buildDualTrackIsoform(pw.exons, pw.trunc_before, pw.trunc_after, {
                preStyleMode: 'ptc-pre',
                mrnaStyleMode: 'ptc',
                ptcList: ptcTargetsFromLayer(layer),
                fadeAfterRank: er,
            }),
            ptcLocFromLayer(layer, 'coding_exon')
        );
    };

    const exLenBpFromFull = (rank) => {
        if (rank == null) return 0;
        const hit = exFull.find(function (x) { return parseInt(x.rank, 10) === parseInt(rank, 10); });
        const n = hit ? parseInt(hit.len_bp, 10) : 0;
        return (isNaN(n) || n <= 0) ? 0 : n;
    };

    const variantIntronHtml = (leftRank, rightRank) => {
        const lbl = (leftRank != null && rightRank != null)
            ? ('Intron between E' + leftRank + ' and E' + rightRank)
            : ('Upstream of first coding exon');
        return '<div style="flex:0 0 12px; min-width:12px; align-self:stretch; display:flex; flex-direction:column; align-items:center; justify-content:center; margin:0 2px;" title="' + hgvsTip(lbl + '.') + '">'
            + '<span style="color:#fbbf24;font-size:12px;line-height:1;text-shadow:0 0 8px rgba(251,191,36,0.45);">\u25C6</span></div>';
    };

    const intronGapHtml = (leftRank, rightRank) => {
        const isVar = vmIntronMatches(leftRank, rightRank);
        // One intron gap: D = 5′ / donor end (junction after upstream exon); A = 3′ / acceptor end (junction before downstream exon).
        // Not the same thing as SpliceAI DS_DG vs DS_AG — those describe predicted mechanism; D/A here are just anatomy labels.
        const structural = 'One intron between E' + leftRank + ' and E' + rightRank + ': D tags the donor (5\u2032) side after E' + leftRank + '; A tags the acceptor (3\u2032) side before E' + rightRank + '.';
        const tip = isVar
            ? hgvsTip(structural + ' Variant locus is placed toward the HGVS-consistent splice end when donor vs acceptor is known.')
            : T(structural);
        const line = '<div style="width:2px;flex:1;min-height:8px;background:linear-gradient(180deg,#475569 0%,#64748b 50%,#475569 100%);border-radius:1px;"></div>';
        const dLbl = '<span style="font-size:0.48rem;line-height:1;color:#64748b;font-weight:700;">D</span>';
        const aLbl = '<span style="font-size:0.48rem;line-height:1;color:#64748b;font-weight:700;">A</span>';
        const mk = (hint) => '<span style="font-size:9px;line-height:1;color:#fbbf24;font-weight:800;margin:1px 0;" title="' + hgvsTip(hint) + '">\u25C6</span>';
        let inner;
        if (!isVar) {
            inner = dLbl + line + aLbl;
        } else if (sv.is_donor && !sv.is_acceptor) {
            inner = dLbl + mk('Variant near donor (5\u2032) end of this intron (schematic).') + line + aLbl;
        } else if (sv.is_acceptor && !sv.is_donor) {
            inner = dLbl + line + mk('Variant near acceptor (3\u2032) end of this intron (schematic).') + aLbl;
        } else {
            inner = dLbl + line + mk('Variant in this intron (see HGVS / consequence).') + aLbl;
        }
        return '<div style="flex:0 0 18px; min-width:18px; align-self:stretch; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; margin:0 1px;" title="' + tip + '">' + inner + '</div>';
    };

    const pm = sv.ptc_markers || {};
    const ptcTargetsFromLayer = function (layer) {
        if (!layer || layer.exon_rank == null || layer.exon_rank === '') return [];
        const er = parseInt(layer.exon_rank, 10);
        if (isNaN(er) || er < 1) return [];
        const bits = [];
        if (layer.hgvs_p) bits.push(String(layer.hgvs_p));
        if (layer.ptc_aa_position != null) bits.push('~aa ' + layer.ptc_aa_position);
        let tip = 'Predicted novel stop (PTC) for this isoform' + (bits.length ? ': ' + bits.join('; ') : '');
        let frac = null;
        if (layer.fraction_in_exon != null && layer.fraction_in_exon !== '') {
            const f = parseFloat(layer.fraction_in_exon);
            if (!isNaN(f)) {
                frac = f;
                tip += ' Vertical tick ~' + Math.round(f * 100) + '% along this exon box (CDS / length-based schematic).';
            }
        }
        const o = { exon_rank: er, tip: tip };
        if (frac != null) o.fraction_in_exon = frac;
        return [o];
    };

    const pseudoExonIntronHtml = (leftRank, rightRank, insertNt, withPtc) => {
        const nt = insertNt != null ? parseInt(insertNt, 10) : 0;
        const lbl = (nt > 0) ? ('+' + nt + ' nt') : 'pseudo-exon';
        const isUtr = withPtc === 'utr';
        const ptcNote = isUtr
            ? '; 5\u2032 UTR (pre-AUG) \u2014 annotated ORF unchanged'
            : (withPtc ? '; may contain internal stop \u2192 PTC/NMD' : '; no premature stop in this isoform');
        const tip = 'Intronic pseudo-exon spliced between E' + leftRank + ' and E' + rightRank
            + (nt > 0 ? (' (~' + nt + ' bp retained from intron)' + ptcNote) : '');
        const sub = isUtr
            ? '<span style="font-weight:500;color:#a7f3d0">5\u2032 UTR</span>'
            : (withPtc
                ? '<span style="font-weight:500;color:#fca5a5">PTC?</span>'
                : '<span style="font-weight:500;color:#a7f3d0">in-frame</span>');
        const st = (withPtc && !isUtr)
            ? 'background: linear-gradient(90deg, rgba(16,185,129,0.22), rgba(248,113,113,0.12)); border: 1px solid #34d399;'
            : 'background: linear-gradient(90deg, rgba(16,185,129,0.28), rgba(52,211,153,0.18)); border: 1px solid #34d399;';
        return '<div style="flex:0 0 56px; min-width:48px; min-height:30px; border-radius:3px; display:flex; align-items:center; justify-content:center; margin:0 2px; ' + st + '" title="' + T(tip) + '">'
            + '<span style="font-size:0.52rem;font-weight:700;color:#6ee7b7;line-height:1.15;text-align:center;">' + T(lbl) + '<br>' + sub + '</span></div>';
    };

    const buildDeepIntronicRetainedSchematic = (cfg) => {
        const anchorEx = (cfg.anchorExon != null && !isNaN(parseInt(cfg.anchorExon, 10))) ? parseInt(cfg.anchorExon, 10) : null;
        let downEx = (cfg.downstreamExon != null && !isNaN(parseInt(cfg.downstreamExon, 10))) ? parseInt(cfg.downstreamExon, 10) : null;
        const preAtg = cfg.preAtgUtr === true;
        if (preAtg && anchorEx != null && (downEx == null || downEx === anchorEx)) {
            downEx = anchorEx + 1;
        }
        const nt = (cfg.retainedNt != null) ? parseInt(cfg.retainedNt, 10) : null;
        const ntStr = (nt != null && !isNaN(nt)) ? String(nt) : '?';
        const five = cfg.fivePrimeSite || { label: 'GT', tip: '5\u2032 splice site' };
        const three = cfg.threePrimeSite || { label: 'AG', tip: '3\u2032 splice site' };
        const hasPtc = cfg.hasPtc === true;
        const ptcFrac = (cfg.ptcFrac != null && !isNaN(parseFloat(cfg.ptcFrac))) ? parseFloat(cfg.ptcFrac) : null;
        const ptcHgvs = (cfg.ptcHgvs || '').trim();
        const dsFade = cfg.downstreamUntranslated === true;
        const accent = cfg.accent || 'green';
        const exons = [];
        if (anchorEx != null) exons.push({ rank: anchorEx, w: 0.42, len_bp: exLenBpFromFull(anchorEx) || 200 });
        if (downEx != null && downEx !== anchorEx) exons.push({ rank: downEx, w: 0.42, len_bp: exLenBpFromFull(downEx) || 200 });
        if (!exons.length) {
            return '<div style="color:var(--sv-muted,#94a3b8);font-size:0.72rem;">Exon context unavailable for schematic.</div>';
        }
        const dual = buildDualTrackIsoform(exons, 0, 0, {
            preStyleMode: 'jun-pre',
            mrnaStyleMode: 'jun',
            targetRank: anchorEx,
            pseudoAfterRank: anchorEx,
            pseudoNt: nt,
            pseudoAccent: accent,
            pseudoPtc: hasPtc,
            pseudoPtcFrac: ptcFrac,
            pseudoPtcHgvs: ptcHgvs,
            pseudoFiveLbl: five.label,
            pseudoThreeLbl: three.label,
            fadeAfterRank: dsFade ? anchorEx : null,
            startCodonExonRank: preAtg ? downEx : (cfg.startCodonExonRank != null ? cfg.startCodonExonRank : null),
            utrExonRank: preAtg ? anchorEx : null,
            isReference: false,
        });
        const note = cfg.noteLine || ('Mature mRNA: exon ' + (anchorEx || '?') + ' + ' + ntStr + ' nt pseudo-exon + exon ' + (downEx || '?') + '.');
        return '<div style="width:100%;display:flex;flex-direction:column;padding:2px 0;box-sizing:border-box;">'
            + dual
            + '<div style="margin-top:8px;font-size:0.58rem;color:var(--sv-muted,#94a3b8);line-height:1.45;width:100%;">' + note + '</div>'
            + '</div>';
    };

    const buildDonorGainPrimarySchematic = (sv) => {
        const eLo = (sv.anchor_exon_rank != null) ? parseInt(sv.anchor_exon_rank, 10)
            : ((sv.target_rank != null) ? parseInt(sv.target_rank, 10) : null);
        let eHi = (sv.next_exon_rank != null) ? parseInt(sv.next_exon_rank, 10) : null;
        const preAtgUtr = sv.pre_atg_utr_pseudoexon === true;
        if (preAtgUtr && eLo != null && (eHi == null || eHi === eLo)) {
            eHi = eLo + 1;
        }
        const nt = (sv.pseudoexon_retained_nt != null) ? parseInt(sv.pseudoexon_retained_nt, 10)
            : ((sv.pseudoexon_insert_nt != null) ? parseInt(sv.pseudoexon_insert_nt, 10) : null);
        const crypticDonorOff = (sv.donor_offset_1based != null) ? parseInt(sv.donor_offset_1based, 10) : null;
        const intronicAgOff = (sv.intronic_ag_offset_1based != null) ? parseInt(sv.intronic_ag_offset_1based, 10) : null;
        const canonGtOff = (sv.canonical_gt_offset_1based != null) ? parseInt(sv.canonical_gt_offset_1based, 10) : 1;
        const model = (sv.pseudoexon_model || '').trim();
        const isNearAg = model === 'nearest_intronic_ag' && intronicAgOff != null && !isNaN(intronicAgOff);
        const hasPtcInPseudo = !preAtgUtr && (
            sv.ptc_location_kind === 'pseudo_exon'
            || sv.pseudoexon_ptc_within_insert === true
            || !!(sv.pseudoexon_ptc_hgvs || '').trim()
        );
        const ptcFrac = sv.pseudoexon_ptc_frac_in_insert;
        const ptcHgvs = (sv.pseudoexon_ptc_hgvs || '').trim();
        const ntStr = (nt != null && !isNaN(nt)) ? String(nt) : '?';
        const crypticGtStr = (crypticDonorOff != null && !isNaN(crypticDonorOff)) ? ('GT(+' + crypticDonorOff + ')') : 'GT (cryptic)';
        let fivePrime;
        let threePrime;
        let note;
        if (isNearAg) {
            const agStr = 'AG(+' + intronicAgOff + ')';
            fivePrime = { label: agStr, tip: 'Nearest upstream intronic acceptor (5\u2032 splice site of pseudo-exon)' };
            threePrime = { label: crypticGtStr, tip: 'Cryptic donor at variant (3\u2032 splice site of pseudo-exon)' };
            note = 'Donor gain (<b>nearest intronic AG</b>): exon ' + (eLo || '?') + ' \u2192 '
                + '<span style="color:#6ee7b7;">' + ntStr + ' nt kept</span> ('
                + '<span style="color:#fdba74;">' + agStr + '</span> \u2192 body \u2192 '
                + '<span style="color:#fbbf24;">' + crypticGtStr + '</span>) \u2192 exon ' + (eHi || '?') + '.';
        } else {
            fivePrime = { label: 'GT(+' + canonGtOff + ')', tip: 'Canonical intronic donor (5\u2032 end of retained block)' };
            threePrime = { label: crypticGtStr, tip: 'Gained cryptic donor (3\u2032 end of retained block)' };
            note = 'Donor gain (<b>canonical proximal</b>): exon ' + (eLo || '?') + ' \u2192 '
                + '<span style="color:#6ee7b7;">' + ntStr + ' nt kept</span> ('
                + '<span style="color:#fbbf24;">GT(+' + canonGtOff + ')</span> through '
                + '<span style="color:#fbbf24;">' + crypticGtStr + '</span>) \u2192 exon ' + (eHi || '?') + '.';
        }
        if (preAtgUtr) {
            note += ' <span style="color:#a7f3d0;">5\u2032 UTR (pre-AUG) \u2014 start codon in exon '
                + (eHi || '?') + ' unchanged; annotated protein ORF not frameshifted by this insert.</span>';
        } else if (hasPtcInPseudo) {
            note += ' <span style="color:#fca5a5;">PTC ' + T(ptcHgvs || 'Ter') + ' inside retained segment.</span>';
        }
        return buildDeepIntronicRetainedSchematic({
            anchorExon: eLo,
            downstreamExon: eHi,
            retainedNt: nt,
            fivePrimeSite: fivePrime,
            threePrimeSite: threePrime,
            hasPtc: hasPtcInPseudo,
            ptcFrac: ptcFrac,
            ptcHgvs: ptcHgvs,
            downstreamUntranslated: hasPtcInPseudo,
            accent: preAtgUtr ? 'sky' : 'green',
            pseudoTip: preAtgUtr ? (ntStr + ' nt 5\u2032 UTR pseudo-exon') : (ntStr + ' nt intronic pseudo-exon retained in mature mRNA'),
            noteLine: note,
            preAtgUtr: preAtgUtr,
            startCodonExonRank: sv.start_codon_exon_rank,
        });
    };

    const buildCanonicalExonizationSchematic = (sv) => buildDonorGainPrimarySchematic(sv);

    const buildAcceptorGainPrimarySchematic = (sv) => {
        const altLike = {
            anchor_exon_rank: sv.anchor_exon_rank,
            downstream_exon_rank: sv.next_exon_rank,
            pseudoexon_retained_nt: sv.pseudoexon_retained_nt != null ? sv.pseudoexon_retained_nt : sv.pseudoexon_insert_nt,
            canonical_proximal_acceptor: sv.in_frame_exonization === true,
            acceptor_offset_1based: sv.acceptor_offset_1based || sv.canonical_acceptor_offset_1based,
            gt_offset_1based: sv.gt_offset_1based,
            ptc_within_insert: sv.pseudoexon_ptc_within_insert,
            ptc_hgvs: sv.pseudoexon_ptc_hgvs,
            ptc_frac_in_insert: sv.pseudoexon_ptc_frac_in_insert,
        };
        const eLo = (altLike.anchor_exon_rank != null) ? parseInt(altLike.anchor_exon_rank, 10) : null;
        const eHi = (altLike.downstream_exon_rank != null) ? parseInt(altLike.downstream_exon_rank, 10) : null;
        const nt = (altLike.pseudoexon_retained_nt != null) ? parseInt(altLike.pseudoexon_retained_nt, 10) : null;
        const canonAcc = altLike.canonical_proximal_acceptor === true;
        const agStr = (altLike.acceptor_offset_1based != null) ? ('AG(+' + altLike.acceptor_offset_1based + ')') : 'AG (gained)';
        const gtStr = canonAcc ? 'GT(+1)' : ((altLike.gt_offset_1based != null) ? ('GT(+' + altLike.gt_offset_1based + ')') : 'GT');
        const ntStr = (nt != null && !isNaN(nt)) ? String(nt) : '?';
        const altHasPtc = sv.ptc_location_kind === 'pseudo_exon' || altLike.ptc_within_insert === true || !!(altLike.ptc_hgvs || '').trim();
        const altPtcHgvs = (altLike.ptc_hgvs || '').trim();
        const altPtcFrac = (sv.pseudoexon_ptc_frac_in_insert != null) ? sv.pseudoexon_ptc_frac_in_insert : altLike.ptc_frac_in_insert;
        let note = 'Acceptor gain: exon ' + (eLo || '?') + ' \u2192 '
            + '<span style="color:#6ee7b7;">' + ntStr + ' nt kept</span> ('
            + '<span style="color:#fbbf24;">' + gtStr + '</span> \u2192 '
            + '<span style="color:#fdba74;">' + agStr + '</span>) \u2192 exon ' + (eHi || '?') + '.';
        if (canonAcc) {
            note += ' Canonical 3\u2032 intron AG bypassed.';
        } else {
            note += ' Local GT\u2192AG pseudo-exon (HGVSc N\u2212 offset + SpliceAI \u0394).';
        }
        if (nt != null && !isNaN(nt) && (nt % 3 !== 0)) {
            note += ' <span style="color:#fcd34d;">' + ntStr + ' nt \u2260 multiple of 3 \u2192 out-of-frame insert (phase = upstream exon end + insert length).</span>';
        }
        if (altHasPtc && altPtcHgvs) {
            note += ' <span style="color:#fca5a5;">' + T(altPtcHgvs) + '</span>';
        }
        if (altHasPtc && sv.ptc_location_label) {
            note += ' <span style="color:var(--sv-muted,#94a3b8);">PTC location: ' + T(sv.ptc_location_label) + '.</span>';
        }
        return buildDeepIntronicRetainedSchematic({
            anchorExon: eLo,
            downstreamExon: eHi,
            retainedNt: nt,
            fivePrimeSite: { label: gtStr, tip: canonAcc ? 'Canonical intronic GT (reused)' : 'Upstream cryptic/decoy GT' },
            threePrimeSite: { label: agStr, tip: 'Gained acceptor (3\u2032 end of retained block)' },
            hasPtc: altHasPtc,
            ptcFrac: altPtcFrac,
            ptcHgvs: altPtcHgvs,
            downstreamUntranslated: altHasPtc,
            accent: 'green',
            pseudoTip: ntStr + ' nt intronic pseudo-exon retained in mature mRNA',
            noteLine: note,
        });
    };

    const buildAcceptorGainAlternateSchematic = (alt) => {
        const eLo = (alt.anchor_exon_rank != null) ? parseInt(alt.anchor_exon_rank, 10) : null;
        const eHi = (alt.downstream_exon_rank != null) ? parseInt(alt.downstream_exon_rank, 10) : null;
        const nt = (alt.pseudoexon_retained_nt != null) ? parseInt(alt.pseudoexon_retained_nt, 10) : null;
        const canonAcc = alt.canonical_proximal_acceptor === true;
        const agStr = (alt.acceptor_offset_1based != null) ? ('AG(+' + alt.acceptor_offset_1based + ')') : 'AG (gained)';
        const gtStr = canonAcc ? 'GT(+1)' : ((alt.gt_offset_1based != null) ? ('GT(+' + alt.gt_offset_1based + ')') : 'GT');
        const ntStr = (nt != null && !isNaN(nt)) ? String(nt) : '?';
        const altHasPtc = alt.ptc_location_kind === 'pseudo_exon' || alt.ptc_within_insert === true || !!(alt.ptc_hgvs || '').trim();
        const altPtcHgvs = (alt.ptc_hgvs || '').trim();
        const altPtcFrac = alt.ptc_frac_in_insert;
        let note = 'Acceptor gain: exon ' + (eLo || '?') + ' \u2192 '
            + '<span style="color:#fde68a;">' + ntStr + ' nt kept</span> ('
            + '<span style="color:#fbbf24;">' + gtStr + '</span> \u2192 '
            + '<span style="color:#fdba74;">' + agStr + '</span>) \u2192 exon ' + (eHi || '?') + '.';
        if (canonAcc) {
            note += ' Canonical 3\u2032 intron AG bypassed.';
        } else {
            note += ' Local decoy GT\u2192AG mini-exon.';
        }
        if (altHasPtc && altPtcHgvs) {
            note += ' <span style="color:#fca5a5;">' + T(altPtcHgvs) + '</span>';
        }
        if (altHasPtc && alt.ptc_location_label) {
            note += ' <span style="color:var(--sv-muted,#94a3b8);">PTC location: ' + T(alt.ptc_location_label) + '.</span>';
        }
        return buildDeepIntronicRetainedSchematic({
            anchorExon: eLo,
            downstreamExon: eHi,
            retainedNt: nt,
            fivePrimeSite: { label: gtStr, tip: canonAcc ? 'Canonical intronic GT (reused)' : 'Upstream cryptic/decoy GT' },
            threePrimeSite: { label: agStr, tip: 'Gained acceptor (3\u2032 end of retained block)' },
            hasPtc: altHasPtc,
            ptcFrac: altPtcFrac,
            ptcHgvs: altPtcHgvs,
            downstreamUntranslated: altHasPtc,
            accent: 'amber',
            pseudoTip: ntStr + ' nt intronic segment retained (acceptor-gain model)',
            noteLine: note,
        });
    };

    const buildStrip = (exonArr, mode, truncBefore, truncAfter, showIntrons, refRow, ptcTargets) => {
        const arr = exonArr || [];
        const ptcList = ptcTargets || [];
        const tb = parseInt(truncBefore || 0, 10) || 0;
        const ta = parseInt(truncAfter || 0, 10) || 0;
        const minPx = refRow ? 4 : 22;
        const parts = [];
        parts.push(buildEllipsis(tb, 'lo'));

        if (refRow && vm && vm.mode === 'intron' && vm.upstream_exon == null && vm.downstream_exon != null
                && arr.length && parseInt(arr[0].rank, 10) === parseInt(vm.downstream_exon, 10)) {
            parts.push(variantIntronHtml(null, vm.downstream_exon));
        }

        for (let i = 0; i < arr.length; i++) {
            const e = arr[i];
            const w = (e.w * 100);
            const r = e.rank;
            let st = 'background:#1e7386;border:1px solid #3db0c7;';
            let tip = 'Exon ' + r + ' — ' + (e.len_bp || '') + ' coding bp (box width \u221d exon length)';
            if (mode === 'skip2' && secTarget != null && r === secTarget) {
                st = 'background: repeating-linear-gradient(135deg, rgba(251, 191, 36, 0.22), rgba(251, 191, 36, 0.22) 4px, rgba(20,20,30,0.4) 4px, rgba(20,20,30,0.4) 8px); border: 1px dashed #fbbf24;';
                tip = (secMech === '3prime_acceptor_loss')
                    ? 'SpliceAI secondary (3′ acceptor loss): parallel whole-exon–skip'
                    : 'SpliceAI secondary (5′ donor loss): parallel whole-exon–skip';
            }
            if (mode === 'skip' && target != null && r === target) {
                st = 'background: repeating-linear-gradient(135deg, rgba(244,63,94,0.2), rgba(244,63,94,0.2) 4px, rgba(20,20,30,0.4) 4px, rgba(20,20,30,0.4) 8px); border: 1px dashed #f43f5e;';
                tip = 'Whole-exon–skip (loss): this exon removed; upstream/downstream exons ligate';
            }
            if (mode === 'jun' && target != null && r === target && sv.junction_row) {
                st = 'background: rgba(16, 185, 129, 0.2); border: 1px solid #34d399; box-shadow: inset 4px 0 0 0 #f59e0b;';
                if (sv.in_frame_exonization && sv.shift_nt != null) {
                    tip = 'In-frame pseudo-exon after E' + r + ': ~' + Math.abs(parseInt(sv.shift_nt, 10))
                        + ' bp intronic sequence retained (canonical acceptor \u2192 cryptic donor); native stop preserved \u2014 no Ter';
                } else if (sv.is_acceptor) {
                    tip = (sv.shift_nt != null)
                        ? ('Acceptor-gain (DS_AG): shifted 3\u2032 splice ~' + Math.abs(sv.shift_nt) + ' nt')
                        : 'Acceptor-gain (DS_AG): shifted 3\u2032 splice';
                } else if (sv.is_donor) {
                    tip = (sv.shift_nt != null)
                        ? ('Donor-gain (DS_DG): shifted 5\u2032 splice ~' + Math.abs(sv.shift_nt) + ' nt')
                        : 'Donor-gain (DS_DG): shifted 5\u2032 splice';
                } else {
                    tip = (sv.shift_nt != null) ? ('Junction shift ~' + Math.abs(sv.shift_nt) + ' nt') : 'Shifted junction';
                }
            }
            if (mode === 'jun' && (target == null || r !== target || !sv.junction_row)) {
                st = 'background: rgba(100, 116, 139, 0.12); border: 1px solid rgba(148, 163, 184, 0.3); opacity: 0.92;';
            }
            const showExonVar = vm && vm.mode === 'exon' && parseInt(vm.exon_rank, 10) === parseInt(r, 10);
            const exonVarMark = showExonVar ? variantExonMarkHtml(r, e.len_bp) : '';
            const ptcHit = ptcList.find(function (p) { return parseInt(p.exon_rank, 10) === parseInt(r, 10); });
            let ptcFrac = null;
            if (ptcHit) {
                const raw = ptcHit.fraction_in_exon != null ? parseFloat(ptcHit.fraction_in_exon) : NaN;
                ptcFrac = !isNaN(raw) ? Math.min(0.97, Math.max(0.03, raw)) : 0.5;
            }
            const ptcLine = ptcHit
                ? '<span style="position:absolute;left:' + (ptcFrac * 100) + '%;top:4px;bottom:15px;width:2px;margin-left:-1px;background:rgba(248,113,113,0.95);border-radius:1px;pointer-events:none;box-shadow:0 0 7px rgba(248,113,113,0.65);z-index:1;" title="' + T(ptcHit.tip) + '"></span>'
                : '';
            const ptcBadge = ptcHit
                ? '<span style="position:absolute;bottom:2px;left:50%;transform:translateX(-50%);font-size:0.52rem;font-weight:800;color:#fca5a5;line-height:1;white-space:nowrap;text-shadow:0 0 8px rgba(248,113,113,0.55);letter-spacing:0.03em;z-index:2;" title="' + T(ptcHit.tip) + '">Ter</span>'
                : '';
            const boxPad = ptcHit ? 'padding-bottom:11px;' : '';
            parts.push('<div style="position:relative;flex:' + w + ' 1 0; min-width:' + minPx + 'px; min-height: 30px; border-radius: 3px; display: flex; align-items: center; justify-content: center; ' + boxPad + st + '" title="' + T(tip) + '">' + exonVarMark + ptcLine + '<span style="font-size:0.65rem; font-weight: 600; color: #e2e8f0; position:relative; z-index:0;">E' + r + '</span>' + ptcBadge + '</div>');
            if (showIntrons && i < arr.length - 1) {
                const diPseudo = sv.deep_intronic_products && sv.pseudoexon_retained_nt != null
                    && target != null && parseInt(r, 10) === parseInt(target, 10);
                if (mode === 'jun' && (sv.in_frame_exonization || diPseudo) && sv.shift_nt != null) {
                    const insNt = diPseudo ? sv.pseudoexon_retained_nt : sv.shift_nt;
                    const preAtgUtr = sv.pre_atg_utr_pseudoexon === true;
                    parts.push(pseudoExonIntronHtml(r, arr[i + 1].rank, insNt, preAtgUtr ? 'utr' : !sv.in_frame_exonization));
                } else {
                    parts.push(intronGapHtml(r, arr[i + 1].rank));
                }
            } else if (refRow && !showIntrons && i < arr.length - 1 && vm && vm.mode === 'intron'
                    && vm.upstream_exon != null && vm.downstream_exon != null
                    && parseInt(vm.upstream_exon, 10) === parseInt(r, 10)
                    && parseInt(vm.downstream_exon, 10) === parseInt(arr[i + 1].rank, 10)) {
                parts.push(variantIntronHtml(vm.upstream_exon, vm.downstream_exon));
            }
        }
        parts.push(buildEllipsis(ta, 'hi'));
        return parts.join('');
    };

    const lossGtGain = sv.spliceai_loss_delta_exceeds_gain === true && sv.spliceai_gain_delta_exceeds_loss !== true;
    const gainGtLoss = sv.spliceai_gain_delta_exceeds_loss === true && sv.spliceai_loss_delta_exceeds_gain !== true;
    const exSkipPri = sv.exon_skip_spliceai_primary === true;
    const jPri = sv.junction_is_primary === true;
    const exEm = '<em style="color:#f43f5e">E' + (target != null ? target : '?') + '</em>';
    let skipHeading = '<span style="color:#fca5a5">Whole-exon\u2013skip</span> \u2014 ' + exEm + ' removed';
    if (exSkipPri && !sv.competing && !jPri) {
        skipHeading = '<span style="color:#fca5a5">Whole-exon\u2013skip (loss primary)</span> \u2014 ' + exEm + ' removed';
    } else if (sv.competing && lossGtGain) {
        skipHeading = '<span style="color:#fca5a5">Preferred loss:</span> whole-exon\u2013skip \u2014 ' + exEm + ' removed';
    } else if (sv.competing && gainGtLoss) {
        skipHeading = '<span style="color:#fca5a5">Parallel whole-exon\u2013skip</span> <span style="color:var(--sv-muted,#94a3b8);font-size:0.65rem;font-weight:500;">(loss product)</span> \u2014 ' + exEm + ' removed';
    } else if (sv.competing) {
        skipHeading = '<span style="color:#fca5a5">Whole-exon\u2013skip</span> <span style="color:var(--sv-muted,#94a3b8);font-size:0.65rem;font-weight:500;">(loss product)</span> \u2014 ' + exEm + ' removed';
    } else if (jPri && sv.junction_row) {
        skipHeading = '<span style="color:#fca5a5">Parallel whole-exon\u2013skip</span> <span style="color:var(--sv-muted,#94a3b8);font-size:0.65rem;font-weight:500;">(baseline if canonical site fails)</span> \u2014 ' + exEm + ' removed';
    }
    const skipRow = spliceMapSection(
        skipHeading,
        buildDualTrackIsoform(fp.exons, fp.trunc_before, fp.trunc_after, {
            preStyleMode: 'skip-pre',
            mrnaStyleMode: 'skip',
            skipRank: target,
            ptcList: ptcTargetsFromLayer(pm.skip),
        }),
        ptcLocFromSv('skip_ptc_location_kind', 'skip_ptc_location_label', 'skip_ptc_location_detail', (pm.skip && pm.skip.hgvs_p) || '')
            || ptcLocFromLayer(pm.skip, 'coding_exon')
    );

    const skipPtcMapRow = buildPtcLocationMapRow(pm.skip, 'after whole-exon skip', fp.exons);
    const primarySkipRow = suppressSkip ? '' : (skipRow + skipPtcMapRow);

    let skip2Row = '';
    if (secTarget != null && fs && fs.exons && fs.exons.length) {
        const secFrameNote = (sv.secondary_in_frame_skip === true)
            ? ' <span style="color:var(--sv-muted,#94a3b8);font-size:0.65rem;font-weight:500;">(multiple of 3; in-frame deletion \u2014 no novel stop from the skip alone)</span>'
            : '';
        const altLabel = sv.deep_intronic_products
            ? '<span style="color:#fbbf24">2. Alternate splice product</span> \u2014 <em style="color:#fbbf24">E' + T(String(secTarget)) + '</em> removed (donor loss)'
            : '<span style="color:#fbbf24">Secondary whole-exon\u2013skip</span> \u2014 <em style="color:#fbbf24">E' + T(String(secTarget)) + '</em> removed';
        skip2Row = spliceMapSection(
            altLabel + secFrameNote,
            buildDualTrackIsoform(fs.exons, fs.trunc_before, fs.trunc_after, {
                preStyleMode: 'skip2-pre',
                mrnaStyleMode: 'skip2',
                skip2Rank: secTarget,
                ptcList: ptcTargetsFromLayer(pm.secondary_skip),
            }),
            ptcLocFromLayer(pm.secondary_skip, 'coding_exon')
                || ptcLocFromSv(
                    'secondary_skip_ptc_location_kind',
                    'secondary_skip_ptc_location_label',
                    'secondary_skip_ptc_location_detail',
                    (pm.secondary_skip && pm.secondary_skip.hgvs_p) || ''
                )
        ) + buildPtcLocationMapRow(pm.secondary_skip, 'after secondary whole-exon skip', fs.exons);
    }

    let junTitleHtml;
    if (sv.pre_atg_utr_pseudoexon && sv.junction_row) {
        const ntUtr = (sv.pseudoexon_retained_nt != null)
            ? (' (+' + sv.pseudoexon_retained_nt + ' nt 5\u2032 UTR, pre-AUG)')
            : '';
        junTitleHtml = '<span style="color:#6ee7b7">1. Primary splice product</span> \u2014 <span style="color:#7dd3fc">donor gain (DS_DG)' + ntUtr + '</span>'
            + ' <span style="color:var(--sv-muted,#94a3b8);font-size:0.68rem;">ORF unchanged; mRNA/translation effects possible</span>';
    } else if (sv.deep_intronic_products && sv.junction_row && sv.in_frame_exonization) {
        const ntLbl = (sv.pseudoexon_insert_nt != null) ? (' (+' + sv.pseudoexon_insert_nt + ' nt pseudo-exon, in-frame)') : ' (in-frame pseudo-exon)';
        junTitleHtml = '<span style="color:#6ee7b7">1. Primary splice product</span> \u2014 <span style="color:#a7f3d0">exonization' + ntLbl + '</span>';
    } else if (sv.deep_intronic_products && sv.junction_row) {
        const ntLbl2 = (sv.pseudoexon_retained_nt != null)
            ? (' (+' + sv.pseudoexon_retained_nt + ' nt pseudo-exon)')
            : '';
        const preAtgFallback = sv.first_mrna_utr && sv.anchor_exon_rank === 1 && !sv.pre_atg_utr_pseudoexon;
        const ptcLbl = (sv.pre_atg_utr_pseudoexon || preAtgFallback)
            ? ''
            : ((sv.pseudoexon_ptc_hgvs || '').trim()
                ? ', <span style="color:#fca5a5">' + T(sv.pseudoexon_ptc_hgvs) + '</span>'
                : ((sv.pseudoexon_ptc_within_insert === true)
                    ? ', <span style="color:#fca5a5">PTC in pseudo-exon</span>'
                    : ''));
        const mechLbl = (sv.primary_mechanism === 'acceptor_gain')
            ? 'acceptor gain (DS_AG)'
            : 'donor gain (DS_DG)';
        junTitleHtml = '<span style="color:#6ee7b7">1. Primary splice product</span> \u2014 <span style="color:#a7f3d0">' + mechLbl + ntLbl2 + ptcLbl + '</span>';
    } else if (sv.is_donor) {
        const secNtLbl = (sv.spliceai_secondary_gain_product && !sv.junction_is_primary && !sv.competing && sv.pseudoexon_retained_nt != null)
            ? (' \u2014 <span style="color:#a7f3d0">+' + sv.pseudoexon_retained_nt + ' nt pseudo-exon retained</span>')
            : '';
        junTitleHtml = sv.junction_is_primary
            ? '<span style="color:#6ee7b7">Donor-gain (DS_DG)</span> <span style="color:#a7f3d0">(primary)</span>'
                + ((sv.pseudoexon_retained_nt != null)
                    ? (' \u2014 <span style="color:#a7f3d0">+' + sv.pseudoexon_retained_nt + ' nt pseudo-exon retained</span>')
                    : '')
            : (sv.competing
                ? '<span style="color:#6ee7b7">Donor-gain (DS_DG)</span> <span style="color:#fbbf24">(competing)</span>'
                : (sv.spliceai_secondary_gain_product
                    ? '<span style="color:#6ee7b7">Donor-gain (DS_DG)</span> <span style="color:#fbbf24">(secondary)</span>' + secNtLbl
                    : '<span style="color:#6ee7b7">Donor-gain (DS_DG)</span>'));
    } else if (sv.is_acceptor) {
        const secNtLblAcc = (sv.spliceai_secondary_gain_product && !sv.junction_is_primary && !sv.competing && sv.pseudoexon_retained_nt != null)
            ? (' \u2014 <span style="color:#a7f3d0">+' + sv.pseudoexon_retained_nt + ' nt pseudo-exon retained</span>')
            : '';
        junTitleHtml = sv.junction_is_primary
            ? '<span style="color:#6ee7b7">Acceptor-gain (DS_AG)</span> <span style="color:#a7f3d0">(primary)</span>'
                + ((sv.pseudoexon_retained_nt != null)
                    ? (' \u2014 <span style="color:#a7f3d0">+' + sv.pseudoexon_retained_nt + ' nt pseudo-exon retained</span>')
                    : '')
            : (sv.competing
                ? '<span style="color:#6ee7b7">Acceptor-gain (DS_AG)</span> <span style="color:#fbbf24">(competing)</span>'
                : (sv.spliceai_secondary_gain_product
                    ? '<span style="color:#6ee7b7">Acceptor-gain (DS_AG)</span> <span style="color:#fbbf24">(secondary)</span>' + secNtLblAcc
                    : '<span style="color:#6ee7b7">Acceptor-gain (DS_AG)</span>'));
    } else if (sv.site === 'intronic') {
        junTitleHtml = '<span style="color:#6ee7b7">Intronic context</span> \u2014 shifted junction';
    } else {
        junTitleHtml = '<span style="color:#6ee7b7">Shifted junction</span>';
    }
    const preAtgUtrMap = sv.pre_atg_utr_pseudoexon === true;
    const junPtcLocHtml = preAtgUtrMap ? ''
        : (ptcLocFromSv('junction_ptc_location_kind', 'junction_ptc_location_label', 'junction_ptc_location_detail', sv.pseudoexon_ptc_hgvs || '')
        || ptcLocFromSv('ptc_location_kind', 'ptc_location_label', 'ptc_location_detail', sv.pseudoexon_ptc_hgvs || '')
        || ptcLocFromLayer(pm.junction, 'coding_exon'));
    const junProductLbl = sv.deep_intronic_products ? 'primary splice product' : 'cryptic splice product';
    const junPtcMapRow = preAtgUtrMap ? ''
        : ((sv.ptc_location_kind === 'pseudo_exon')
            ? ''
            : buildPtcLocationMapRow(pm.junction, junProductLbl, fj.exons));
    const hasPseudoRetained = sv.pseudoexon_retained_nt != null
        || (sv.shift_nt != null && parseInt(sv.shift_nt, 10) > 0);
    const pseudoAnchorRank = (sv.pseudo_after_rank != null)
        ? sv.pseudo_after_rank
        : (hasPseudoRetained && sv.junction_row)
            ? (sv.anchor_exon_rank != null ? sv.anchor_exon_rank : target)
            : null;
    const pseudoNtVal = sv.pseudoexon_retained_nt != null
        ? sv.pseudoexon_retained_nt
        : (sv.shift_nt != null && parseInt(sv.shift_nt, 10) > 0 ? sv.shift_nt : null);
    const junRow = spliceMapSection(
        junTitleHtml,
        sv.use_exonization_schematic
            ? ((sv.primary_mechanism === 'acceptor_gain')
                ? buildAcceptorGainPrimarySchematic(sv)
                : buildCanonicalExonizationSchematic(sv))
            : buildDualTrackIsoform(fj.exons, fj.trunc_before, fj.trunc_after, {
                preStyleMode: 'jun-pre',
                mrnaStyleMode: 'jun',
                targetRank: target,
                pseudoAfterRank: pseudoAnchorRank,
                pseudoNt: pseudoNtVal,
                pseudoFiveLbl: (sv.donor_offset_1based != null) ? ('GT(+' + sv.donor_offset_1based + ')') : 'GT',
                pseudoThreeLbl: (sv.acceptor_offset_1based != null) ? ('AG(+' + sv.acceptor_offset_1based + ')') : 'AG',
                pseudoPtc: preAtgUtrMap ? false : (sv.ptc_location_kind === 'pseudo_exon' || sv.pseudoexon_ptc_within_insert === true || !!(sv.pseudoexon_ptc_hgvs || '').trim()),
                pseudoPtcMode: preAtgUtrMap ? 'utr' : null,
                pseudoPtcFrac: preAtgUtrMap ? null : sv.pseudoexon_ptc_frac_in_insert,
                pseudoPtcHgvs: preAtgUtrMap ? null : sv.pseudoexon_ptc_hgvs,
                ptcList: (sv.ptc_location_kind === 'pseudo_exon') ? [] : ptcTargetsFromLayer(pm.junction),
                exonInternalCutRank: sv.exon_internal_cut_rank,
                exonInternalCutFraction: sv.exon_internal_cut_fraction,
                exonInternalCutSide: sv.exon_internal_cut_side,
            }),
        junPtcLocHtml
    ) + junPtcMapRow;

    const buildAcceptorGainAltMapRow = (alt, label, sublabel) => {
        const ntAlt = (alt.pseudoexon_retained_nt != null) ? (' (+' + alt.pseudoexon_retained_nt + ' nt)') : '';
        const sub = sublabel ? (' \u2014 <span style="color:var(--sv-muted,#94a3b8);font-size:0.68rem;">' + T(sublabel) + '</span>') : '';
        const altTitle = '<span style="color:#fbbf24">' + label + '. Alternate splice product</span> \u2014 <span style="color:#fde68a">acceptor gain (DS_AG)' + ntAlt + '</span>' + sub;
        return spliceMapSection(
            altTitle,
            buildAcceptorGainAlternateSchematic(alt),
            ptcLocFromAlt(alt)
        );
    };

    let altProductRow = '';
    if (sv.has_deep_intronic_alternate && sv.deep_intronic_viz_alternate) {
        const alt = sv.deep_intronic_viz_alternate;
        const altRetained = (alt.pseudoexon_retained_nt != null) ? parseInt(alt.pseudoexon_retained_nt, 10) : 0;
        const skipFullIntronAlt = (
            alt.mechanism === 'acceptor_gain'
            && alt.canonical_proximal_acceptor === true
            && altRetained > 600
        );
        if (alt.mechanism === 'acceptor_gain' && !skipFullIntronAlt) {
            const dual = !!sv.has_deep_intronic_alternate2;
            altProductRow += buildAcceptorGainAltMapRow(
                alt,
                dual ? '2a' : '2',
                dual ? 'canonical GT \u2192 gained AG' : null
            );
        }
    }
    if (sv.has_deep_intronic_alternate2 && sv.deep_intronic_viz_alternate2) {
        const alt2 = sv.deep_intronic_viz_alternate2;
        if (alt2.mechanism === 'acceptor_gain') {
            altProductRow += buildAcceptorGainAltMapRow(alt2, '2b', 'local decoy GT \u2192 gained AG');
        }
    }

    const mapTitle = sv.reference_only ? 'Transcript exon map' : 'Splice exon map';
    const refHgvsLbl = hgvsViz
        ? ' <span style="color:var(--sv-muted,#94a3b8);font-size:0.65rem;font-weight:500;">— ' + T(hgvsViz)
            + (sv.pre_atg_utr_pseudoexon && sv.start_codon_exon_rank
                ? ' (intron between E1 and E' + sv.start_codon_exon_rank + ')'
                : (target != null ? ' (E' + target + ')' : ''))
            + '</span>'
        : (target != null ? ' <span style="color:var(--sv-muted,#94a3b8);font-size:0.65rem;font-weight:500;">— E' + target + '</span>' : '');
    let h = '<div class="splice-viz-wrap" style="width:100%; flex-basis: 100%; margin-top: 14px; margin-bottom: 4px; padding: 12px 12px 14px; background: rgba(0,0,0,0.22); border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); box-sizing: border-box;">';
    h += '<div style="font-size:0.8rem; font-weight: 600; color: #3db0c7; margin-bottom: 10px;">' + mapTitle + '</div>';
    if (showReference) {
        const refArr = (target != null && fp.exons && fp.exons.length) ? fp.exons : exFull;
        const refTb = (target != null && fp.exons && fp.exons.length) ? (fp.trunc_before || 0) : 0;
        const refTa = (target != null && fp.exons && fp.exons.length) ? (fp.trunc_after || 0) : 0;
        const refPtcList = ptcTargetsFromLayer(pm.reference);
        const refPtcEr = (pm.reference && pm.reference.exon_rank != null) ? parseInt(pm.reference.exon_rank, 10) : null;
        const refPtcCap = ptcLocFromSv('reference_ptc_location_kind', 'reference_ptc_location_label', 'reference_ptc_location_detail', (pm.reference && pm.reference.hgvs_p) || '')
            || ptcLocFromLayer(pm.reference, 'coding_exon');
        h += spliceMapSection(
            '<span style="color:#3db0c7;">Reference</span>' + refHgvsLbl
                + (target != null
                    ? ' <span style="color:#64748b;font-size:0.62rem;">(zoomed \u00b12 exons around E'
                        + (sv.pre_atg_utr_pseudoexon && sv.start_codon_exon_rank ? sv.start_codon_exon_rank : target)
                        + ')</span>'
                    : ''),
            buildReferenceGeneTrack(refArr, refTb, refTa, {
                ptcList: refPtcList,
                fadeAfterRank: refPtcEr,
                startCodonExonRank: sv.start_codon_exon_rank,
                utrExonRank: sv.pre_atg_utr_pseudoexon ? 1 : null,
            }),
            refPtcCap
        );
        if (sv.reference_only && pm.reference && !ptcExonInWindow(refArr, pm.reference)) {
            h += buildPtcLocationMapRow(pm.reference, 'mutant ORF');
        }
    }
    if (showIsoforms) {
        if (ro === 'ref_junction_skip' && sv.junction_row) {
            h += junRow + altProductRow + primarySkipRow + skip2Row;
        } else if (ro === 'ref_skip_junction' && sv.junction_row) {
            h += primarySkipRow + skip2Row + junRow + altProductRow;
        } else {
            h += primarySkipRow + skip2Row + altProductRow;
        }
    }
    if (showReference || showIsoforms) {
        h += '<div style="font-size:0.68rem;color:var(--sv-muted,#94a3b8);margin-top:10px;line-height:1.45;border-top:1px solid var(--line,rgba(255,255,255,0.06));padding-top:8px;">'
            + '<strong style="color:var(--sv-ink,#cbd5e1);">How to read this map</strong> '
            + (showReference ? '<span style="color:#fbbf24;">\u25C6</span> = variant locus on the reference gene row (exon position is schematic from HGVSc). ' : '')
            + (showIsoforms
                ? '(schematic; exon box width \u221d coding bp — same width in Pre-mRNA and mRNA rows). Each isoform shows a <strong>Pre-mRNA</strong> row (gene with introns) and an <strong>mRNA</strong> row (spliced product). '
                    + 'Striped exon = removed in that isoform\u2019s mRNA product. '
                    + 'Dashed green <strong>pseudo-exon</strong> = intronic segment retained between splice sites (GT/AG labels on Pre-mRNA; ORF body only in bp counts). '
                    + '<strong>Ter</strong> = premature stop in the translated ORF. '
                    + '<strong style="color:#fde68a;">Ter on dashed pseudo-exon</strong> = stop inside the retained intronic segment; '
                    + '<strong style="color:#fca5a5;">Ter on an exon box</strong> = stop in native coding exon sequence. '
                    + 'Each isoform row lists <strong style="color:#fca5a5;">PTC location</strong> when a stop is predicted. '
                    + (sv.exon_internal_cut_rank != null
                        ? '<strong style="color:#fbbf24;">Dashed amber line</strong> on an exon box = cryptic '
                            + (sv.exon_internal_cut_side === 'donor' ? 'donor (GT)' : 'acceptor (AG)')
                            + ' inside that exon; the half on the <strong style="color:#fca5a5;">red-striped side</strong> is spliced out of the mature mRNA. '
                        : '')
                    + 'Scroll horizontally on narrow screens if the full gene row overflows.'
                    + (sv.use_exonization_schematic
                        ? ' Deep intronic products follow the pseudo-exon model (panel d): intronic insertion between flanking exons.'
                        : '')
                : 'Exon box width \u221d coding bp on this transcript.'
                    + (pm.reference ? ' <strong>Mutant mRNA</strong> row and <strong style="color:#fca5a5;">Novel stop (PTC)</strong> row show the predicted premature stop when resolved. ' : '')
                    + ' <strong style="color:#fca5a5;">Novel stop (PTC)</strong> rows zoom to the stop exon when it lies outside the variant-centered isoform window.')
            + '</div>';
    }
    h += '</div>';
    return h;
}
