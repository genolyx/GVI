/**
 * Junction sequence alignment — stacked IGV-style tracks with coordinate ruler.
 * Payload: parsed_data.junction_align_viz from app_v11 analyze API.
 */
(function (global) {
    'use strict';

    const CELL_W = 14;
    const KIND_STYLE = {
        exon: { bg: 'rgba(59,130,246,0.4)', border: '#3b82f6', color: '#dbeafe' },
        intron: { bg: 'rgba(51,65,85,0.45)', border: '#475569', color: '#cbd5e1' },
        exon_extension: { bg: 'rgba(16,185,129,0.4)', border: '#10b981', color: '#d1fae5' },
        utr_extension: { bg: 'rgba(56,189,248,0.35)', border: '#38bdf8', color: '#e0f2fe' },
        exon_extension_intronic: { bg: 'rgba(16,185,129,0.28)', border: '#059669', color: '#a7f3d0' },
        exon_extension_prior_exon: { bg: 'rgba(52,211,153,0.45)', border: '#34d399', color: '#ecfdf5' },
        splice_ag: { bg: 'rgba(251,191,36,0.55)', border: '#f59e0b', color: '#fef3c7' },
        splice_gt: { bg: 'rgba(251,191,36,0.55)', border: '#f59e0b', color: '#fef3c7' },
        splice_loss: { bg: 'rgba(239,68,68,0.6)', border: '#ef4444', color: '#fee2e2' },
        splice_gain: { bg: 'rgba(16,185,129,0.6)', border: '#10b981', color: '#d1fae5' },
        exon_deleted: { bg: 'rgba(100,116,139,0.2)', border: '#64748b', color: '#94a3b8' },
        deleted: { bg: 'rgba(127,29,29,0.35)', border: '#991b1b', color: '#fca5a5' },
        exon_skip: { bg: 'rgba(244,63,94,0.25)', border: '#f43f5e', color: '#fecdd3' },
        dup: { bg: 'rgba(51,65,85,0.45)', border: '#475569', color: '#cbd5e1' },
        variant: { bg: 'rgba(51,65,85,0.45)', border: '#475569', color: '#cbd5e1' },
        protein_gly: { bg: 'rgba(56,189,248,0.45)', border: '#38bdf8', color: '#e0f2fe' },
        protein_x: { bg: 'rgba(148,163,184,0.35)', border: '#94a3b8', color: '#e2e8f0' },
        protein_y: { bg: 'rgba(167,139,250,0.35)', border: '#a78bfa', color: '#ede9fe' },
        protein_plain: { bg: 'rgba(71,85,105,0.35)', border: '#64748b', color: '#cbd5e1' },
        protein_variant: { bg: 'rgba(239,68,68,0.55)', border: '#ef4444', color: '#fee2e2' },
        ptc: { bg: 'rgba(239,68,68,0.5)', border: '#ef4444', color: '#fee2e2' },
        start_codon: { bg: 'rgba(34,197,94,0.45)', border: '#22c55e', color: '#dcfce7' },
    };

    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function inSpan(i, spans, kind) {
        for (let s = 0; s < (spans || []).length; s++) {
            const sp = spans[s];
            if (kind && sp.kind !== kind) continue;
            if (i >= sp.start && i < sp.end) return sp;
        }
        return null;
    }

    function ensureModalShell() {
        let el = document.getElementById('junctionAlignModal');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'junctionAlignModal';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.style.cssText = [
            'display:none', 'position:fixed', 'inset:0', 'z-index:12000',
            'background:rgba(2,6,23,0.88)', 'align-items:center', 'justify-content:center',
            'padding:16px', 'box-sizing:border-box',
        ].join(';');
        el.innerHTML = [
            '<div id="junctionAlignPanel" style="',
            'max-width:min(1200px,98vw);max-height:92vh;overflow-x:hidden;overflow-y:auto;',
            'background:linear-gradient(165deg,#0b1220,#1a2332);',
            'border:1px solid rgba(255,255,255,0.1);border-radius:12px;',
            'padding:16px 18px 20px;box-shadow:0 24px 60px rgba(0,0,0,0.6);',
            'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#e2e8f0;',
            '">',
            '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;">',
            '<div>',
            '<div id="jaModalTitle" style="font-family:Outfit,system-ui,sans-serif;font-size:1.05rem;font-weight:600;color:#7dd3fc;"></div>',
            '<div id="jaModalSubtitle" style="font-family:Outfit,system-ui,sans-serif;font-size:0.76rem;color:#94a3b8;margin-top:3px;"></div>',
            '</div>',
            '<button type="button" id="jaModalClose" aria-label="Close" style="',
            'flex:0 0 auto;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);',
            'color:#f8fafc;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:0.85rem;',
            'font-family:Outfit,system-ui,sans-serif;',
            '">Close</button>',
            '</div>',
            '<div id="jaModalBody"></div>',
            '<div id="jaModalLegend" style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);',
            'font-family:Outfit,system-ui,sans-serif;font-size:0.7rem;color:#94a3b8;display:flex;flex-wrap:wrap;gap:10px;"></div>',
            '</div>',
        ].join('');
        document.body.appendChild(el);
        el.addEventListener('click', function (ev) {
            if (ev.target === el) closeJunctionAlignModal();
        });
        document.getElementById('jaModalClose').addEventListener('click', closeJunctionAlignModal);
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') closeJunctionAlignModal();
        });
        return el;
    }

    function renderRuler(ruler, gridW, opts) {
        opts = opts || {};
        if (!ruler || !ruler.length) return '';
        const padLeft = opts.noPad ? 0 : 148;
        const parts = ['<div style="display:flex;margin-bottom:2px;padding-left:' + padLeft + 'px;">'];
        parts.push('<div style="position:relative;width:' + gridW + 'px;height:18px;">');
        ruler.forEach(function (tick) {
            const left = tick.index * CELL_W;
            parts.push(
                '<div style="position:absolute;left:' + left + 'px;top:0;font-size:9px;color:#64748b;'
                + 'font-family:Outfit,sans-serif;white-space:nowrap;transform:translateX(-2px);">'
                + esc(tick.label) + '</div>'
            );
        });
        parts.push('</div></div>');
        return parts.join('');
    }

    function isPremrnaTrack(track) {
        if (!track) return false;
        if (track.id === 'reference' || track.id === 'mutant') return true;
        return track.kind === 'premrna';
    }

    function renderPremrnaScrollBlock(premrnaTracks, ruler, gridW, payload) {
        if (!premrnaTracks.length) return '';
        const parts = [];
        const scrollHint = payload && payload.deep_map
            ? ' <span style="color:#64748b;font-size:0.68rem;">(reference + mutant scroll together; product rows stay fixed)</span>'
            : '';
        parts.push('<div style="margin-bottom:4px;font-family:Outfit,sans-serif;font-size:0.68rem;color:#64748b;">'
            + 'Pre-mRNA tracks' + scrollHint + '</div>');
        parts.push('<div style="display:flex;align-items:flex-start;gap:8px;">');
        parts.push('<div style="flex:0 0 140px;display:flex;flex-direction:column;gap:6px;padding-top:20px;">');
        premrnaTracks.forEach(function (tr) {
            const titleColor = '#a7f3d0';
            parts.push('<div style="font-family:Outfit,sans-serif;font-size:0.72rem;font-weight:600;color:'
                + titleColor + ';line-height:1.3;min-height:28px;padding-top:4px;">' + esc(tr.title) + '</div>');
        });
        parts.push('</div>');
        parts.push('<div class="ja-premrna-scroll" style="flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;'
            + 'border-radius:6px;border:1px solid rgba(255,255,255,0.06);padding:4px 2px 6px;">');
        parts.push('<div class="ja-premrna-inner" style="width:' + gridW + 'px;min-width:100%;">');
        parts.push(renderRuler(ruler, gridW, { noPad: true }));
        premrnaTracks.forEach(function (tr) {
            parts.push(renderTrack(tr, { sequenceOnly: true }));
        });
        parts.push('</div></div></div>');
        return parts.join('');
    }

    function renderBaseCell(nt, kind, span, ptcSpan, markerHere, hgvs, cellW) {
        const w = cellW || CELL_W;
        const st = KIND_STYLE[kind] || KIND_STYLE.intron;
        let underline = '';
        if (span && (span.kind === 'dup' || span.kind === 'variant')) {
            underline = 'border-bottom:3px solid #ef4444;';
        }
        let extra = '';
        if (ptcSpan) {
            const pst = KIND_STYLE.ptc;
            extra = 'background:' + pst.bg + ';border:2px solid ' + pst.border + ';color:' + pst.color + ';';
        } else if (markerHere) {
            if (markerHere.kind === 'ptc') {
                extra = 'outline:2px solid #ef4444;outline-offset:-1px;';
            } else if (markerHere.kind === 'splice_ag_skipped') {
                extra = 'border-bottom:2px dashed #94a3b8;opacity:0.85;';
            } else if (markerHere.kind === 'splice_ag' || markerHere.kind === 'splice_gt') {
                extra = 'box-shadow:0 0 0 1px #fbbf24 inset;';
            } else if (markerHere.kind === 'splice_loss') {
                const ls = KIND_STYLE.splice_loss;
                extra = 'background:' + ls.bg + ';border:2px solid ' + ls.border + ';color:' + ls.color
                    + ';box-shadow:0 0 7px ' + ls.border + ';text-decoration:line-through;';
            } else if (markerHere.kind === 'splice_gain') {
                const gs = KIND_STYLE.splice_gain;
                extra = 'background:' + gs.bg + ';border:2px solid ' + gs.border + ';color:' + gs.color
                    + ';box-shadow:0 0 7px ' + gs.border + ';';
            } else if (markerHere.kind === 'exon_start') {
                extra = 'border-left:3px solid #60a5fa;';
            } else if (markerHere.kind === 'start_codon') {
                const sc = KIND_STYLE.start_codon;
                extra = 'background:' + sc.bg + ';border:2px solid ' + sc.border + ';color:' + sc.color
                    + ';box-shadow:0 0 6px rgba(34,197,94,0.45);';
            } else if (markerHere.kind === 'variant_locus') {
                extra = 'outline:2px dashed #f97316;outline-offset:-1px;';
            }
        }
        const tip = (hgvs ? hgvs + ' · ' : '') + nt;
        return '<span title="' + esc(tip) + '" style="display:inline-block;width:' + w + 'px;text-align:center;'
            + 'box-sizing:border-box;padding:2px 0;margin:0;border-radius:1px;'
            + 'background:' + st.bg + ';border:1px solid ' + st.border + ';color:' + st.color + ';'
            + underline + extra + '">' + esc(nt) + '</span>';
    }

    function renderTrack(track, opts) {
        opts = opts || {};
        const bases = track.bases || [];
        const spans = track.spans || [];
        const markers = track.markers || [];
        const markerAt = {};
        markers.forEach(function (m) {
            if (m.index != null) markerAt[m.index] = m;
        });

        const parts = [];
        const titleColor = track.kind === 'mature' ? '#fde68a' : '#a7f3d0';
        if (!opts.sequenceOnly) {
            parts.push('<div class="ja-track-row" style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px;min-height:28px;">');
            parts.push('<div style="flex:0 0 140px;font-family:Outfit,sans-serif;font-size:0.72rem;font-weight:600;color:'
                + titleColor + ';line-height:1.3;padding-top:4px;">' + esc(track.title) + '</div>');
        } else {
            parts.push('<div class="ja-track-row" style="margin-bottom:6px;min-height:28px;">');
        }
        const seqWrapClass = opts.fixed ? 'ja-track-fixed' : 'ja-track-seq';
        const seqWrapStyle = opts.fixed
            ? 'flex:1;overflow-x:visible;min-width:0;'
            : (opts.sequenceOnly ? '' : 'flex:0 0 auto;');
        if (!opts.sequenceOnly) {
            parts.push('<div class="' + seqWrapClass + '" style="' + seqWrapStyle + '">');
        }
        const codonAligned = !!track.codon_aligned;
        const trackW = codonAligned
            ? bases.reduce(function (sum, b) { return sum + (b.codon_span || 1) * CELL_W; }, 0)
            : Math.max(bases.length, 1) * CELL_W;
        parts.push('<div style="width:' + trackW + 'px;white-space:nowrap;line-height:1;">');

        if (!bases.length && spans.length && spans[0].kind === 'exon_skip') {
            parts.push('<span style="display:inline-block;padding:4px 12px;border:1px dashed #f43f5e;border-radius:4px;'
                + 'color:#fecdd3;font-family:Outfit,sans-serif;font-size:0.75rem;">'
                + esc(spans[0].label || 'exon skipped') + '</span>');
        } else if (codonAligned) {
            for (let i = 0; i < bases.length; i++) {
                const b = bases[i];
                const cellW = (b.codon_span || 1) * CELL_W;
                const emphSpan = inSpan(i, spans, 'variant');
                const sp = emphSpan || inSpan(i, spans);
                let kind = b.kind || 'protein_x';
                if (sp && sp.kind === 'variant' && track.variant_style !== 'underline') {
                    kind = 'protein_variant';
                }
                const tipRole = b.triplet_role ? (' · ' + b.triplet_role + ' in Gly-X-Y') : '';
                parts.push(renderBaseCell(
                    b.nt, kind, emphSpan || sp, null, markerAt[i],
                    (b.hgvs || '') + tipRole, cellW,
                ));
            }
        } else {
            for (let i = 0; i < bases.length; i++) {
                const b = bases[i];
                const ptcSpan = inSpan(i, spans, 'ptc');
                // Variant / dup spans MUST win over exon_skip / exon_extension
                // for visual emphasis — otherwise a variant base sitting inside
                // a spliced-out region would lose its red underline because
                // inSpan(i, spans) returns the exon_skip first.
                const emphSpan = inSpan(i, spans, 'variant') || inSpan(i, spans, 'dup');
                const sp = ptcSpan || inSpan(i, spans);
                let kind = b.kind || 'intron';
                if (kind === 'exon_deleted') kind = 'exon_deleted';
                else if (kind === 'deleted') kind = 'deleted';
                else if (ptcSpan) kind = 'ptc';
                else if (sp && (sp.kind === 'exon_extension' || sp.kind === 'utr_extension') && kind !== 'exon') kind = sp.kind;
                parts.push(renderBaseCell(b.nt, kind, emphSpan || sp, ptcSpan, markerAt[i], b.hgvs));
            }
        }

        parts.push('</div>');

        const ann = [];
        spans.forEach(function (sp) {
            if (sp.kind === 'dup' && sp.label) ann.push(sp.label);
            if ((sp.kind === 'exon_extension' || sp.kind === 'utr_extension') && sp.label) ann.push(sp.label);
            if (sp.kind === 'exon' && sp.label) ann.push(sp.label);
            if (sp.kind === 'ptc' && sp.label) ann.push('Ter: ' + sp.label);
        });
        markers.forEach(function (m) {
            if (m.kind === 'ptc' && m.label) ann.push('PTC: ' + m.label);
            if (m.kind === 'start_codon' && m.label) ann.push(m.label);
            if (m.kind === 'variant_locus' && m.label) ann.push(m.label);
            if ((m.kind === 'exon_start' || m.kind === 'splice_gt' || m.kind === 'splice_ag'
                || m.kind === 'splice_ag_skipped' || m.kind === 'splice_loss'
                || m.kind === 'splice_gain') && m.label) ann.push(m.label);
        });
        if (ann.length) {
            parts.push('<div style="margin-top:3px;font-family:Outfit,sans-serif;font-size:0.65rem;color:#64748b;">'
                + esc(ann.join(' · ')) + '</div>');
        }
        if (track.summary) {
            parts.push('<div style="margin-top:2px;font-family:Outfit,sans-serif;font-size:0.72rem;color:#fcd34d;">'
                + esc(track.summary) + '</div>');
        }
        if (track.dup_seq) {
            parts.push('<div style="margin-top:2px;font-family:Outfit,sans-serif;font-size:0.68rem;color:#fca5a5;">'
                + 'Dup insert: <code style="color:#fecaca;">' + esc(track.dup_seq) + '</code> ('
                + track.dup_seq.length + ' nt)</div>');
        }
        if (track.note) {
            parts.push('<div style="margin-top:4px;font-family:Outfit,sans-serif;font-size:0.68rem;color:#94a3b8;line-height:1.4;">'
                + esc(track.note) + '</div>');
        }
        if (!opts.sequenceOnly) {
            parts.push('</div>');
        }
        parts.push('</div>');
        return parts.join('');
    }

    function refTrackWidth(payload) {
        const ref = (payload.tracks || []).find(function (t) { return t.id === 'reference'; });
        const n = ref && ref.bases ? ref.bases.length : 0;
        return Math.max(n, 1) * CELL_W;
    }

    function renderCollagenGlyXyBanner(stats) {
        if (!stats || (!stats.motif_summary && stats.block_repeat_count == null)) return '';
        const inView = stats.window_repeat_count || 0;
        let main = stats.motif_summary || '';
        const refMut = (stats.reference_aa && stats.mutant_aa)
            ? (' · <strong style="color:#f0f9ff;">Reference '
                + esc(stats.reference_aa) + ' → mutant ' + esc(stats.mutant_aa) + '</strong>')
            : '';
        if (!main) {
            const block = stats.block_repeat_count || 0;
            if (block > 0 && stats.block_aa_lo && stats.block_aa_hi) {
                main = block + ' consecutive Gly-X-Y repeat' + (block === 1 ? '' : 's')
                    + ' natively (aa ' + stats.block_aa_lo + '–' + stats.block_aa_hi + ')';
                if (stats.meets_nine_rule) {
                    main += ' · meets ≥9 repeat rule';
                }
            } else {
                main = 'No uninterrupted native Gly-X-Y block at this site';
            }
        }
        if (stats.in_gxg_linker) {
            main = 'Gly-X-Gly flexible linker between triple-helical segments';
            if (stats.block_repeat_count > 0) {
                main += ' (within a longer Gly register)';
            }
        }
        const viewTxt = inView
            ? (' · ' + inView + ' native Gly-X-Y repeat' + (inView === 1 ? '' : 's') + ' in map window')
            : '';
        const triplet = stats.variant_triplet
            ? (' · reference triplet: ' + stats.variant_triplet)
            : '';
        let roleHint = '';
        if (stats.native_register === false) {
            roleHint = ' · <strong style="color:#fca5a5;">Not in a native Gly-X-Y block</strong>'
                + ' — slot colors disabled; variant does not replace a collagen Gly anchor';
        } else if (stats.variant_at_gly) {
            roleHint = ' · <strong style="color:#f0f9ff;">Disrupts native Gly anchor</strong>'
                + ' (Gly slot, reference G)';
        } else if (stats.variant_triplet_role) {
            roleHint = ' · variant at <strong style="color:#f0f9ff;">'
                + esc(stats.variant_triplet_role)
                + '</strong> slot — does <em>not</em> replace a native Gly anchor';
        }
        if (stats.in_gxg_linker && stats.gxg_linker_note) {
            roleHint = ' · <strong style="color:#fde68a;">Gly-X-Gly flexible linker</strong>'
                + ' — no theoretical collagen motif score (PMID: 16919298); functional investigation may still apply';
        }
        return '<div style="margin-bottom:10px;padding:10px 12px;border-radius:8px;'
            + 'background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.35);'
            + 'font-family:Outfit,sans-serif;font-size:0.78rem;color:#bae6fd;line-height:1.45;">'
            + '<strong style="color:#7dd3fc;">Collagen motif:</strong> '
            + esc(main + viewTxt + triplet)
            + refMut
            + roleHint
            + '</div>';
    }

    function wireJunctionAlignScroll(payload) {
        const scroller = document.querySelector('#jaModalBody .ja-premrna-scroll');
        if (!scroller) return;
        const ref = (payload.tracks || []).find(function (t) { return t.id === 'reference'; });
        const refLen = ref && ref.bases ? ref.bases.length : 0;
        let target = 0;
        const junctionAtStart = payload.scroll_junction_at === 'start';
        if (payload.scroll_default === 'variant' && payload.variant_base_index != null) {
            target = Math.max(0, payload.variant_base_index * CELL_W - 80);
        } else if (payload.scroll_default === 'junction' || payload.deep_map) {
            if (junctionAtStart) {
                target = 0;
            } else {
                target = Math.max(0, refLen * CELL_W - (scroller.clientWidth || 400) + 40);
            }
        }
        scroller.scrollLeft = target;
    }

    function renderDeepMapBanner(payload) {
        if (!payload || !payload.deep_map) return '';
        const hint = payload.scroll_hint || (
            'Long intron map — scroll horizontally on the pre-mRNA row. '
            + (payload.scroll_junction_at === 'start'
                ? 'Junction (exon/GT) is at the left; scroll right for the variant locus.'
                : 'Junction (AG/exon) is at the right; scroll left for the variant locus.')
        );
        return '<div style="margin-bottom:10px;padding:9px 12px;border-radius:8px;'
            + 'background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.35);'
            + 'font-family:Outfit,sans-serif;font-size:0.76rem;color:#fde68a;line-height:1.45;">'
            + '<strong style="color:#fbbf24;">Deep intronic map</strong> — '
            + esc(hint)
            + '</div>';
    }

    function openJunctionAlignModal(payload) {
        if (!payload || !payload.eligible) return;
        ensureModalShell();
        const modal = document.getElementById('junctionAlignModal');
        const bodyEl = document.getElementById('jaModalBody');
        const legEl = document.getElementById('jaModalLegend');

        document.getElementById('jaModalTitle').textContent = payload.title || 'Junction alignment';
        document.getElementById('jaModalSubtitle').textContent = payload.subtitle || (
            (payload.anchor_hgvs || '')
            + (payload.downstream_exon ? (' · junction exon ' + payload.downstream_exon) : '')
            + ' · mRNA/cDNA sense (T,A,C,G); red underline = variant span (del/dup); Ter = 3-nt stop when in view'
        );

        const gridW = refTrackWidth(payload);
        const parts = [];
        const rulerLabel = payload.map_type === 'collagen_gly'
            ? 'Coordinate ruler (HGVSc positions; protein row is codon-aligned)'
            : 'Coordinate ruler (HGVSc positions)';
        parts.push('<div style="margin-bottom:8px;font-family:Outfit,sans-serif;font-size:0.7rem;color:#64748b;">'
            + rulerLabel + '</div>');
        if (payload.collagen_gly_xy) {
            parts.push(renderCollagenGlyXyBanner(payload.collagen_gly_xy));
        }
        parts.push(renderDeepMapBanner(payload));
        const allTracks = payload.tracks || [];
        const premrnaTracks = allTracks.filter(isPremrnaTrack);
        const productTracks = allTracks.filter(function (t) { return !isPremrnaTrack(t); });
        const usePremrnaScroll = premrnaTracks.length > 0;
        if (usePremrnaScroll) {
            parts.push(renderPremrnaScrollBlock(premrnaTracks, payload.ruler || [], gridW, payload));
        } else {
            parts.push(renderRuler(payload.ruler || [], gridW));
        }
        parts.push('<div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">');
        if (productTracks.length) {
            if (usePremrnaScroll) {
                parts.push('<div style="margin:10px 0 6px;font-family:Outfit,sans-serif;font-size:0.68rem;color:#64748b;">'
                    + 'Splice products (fixed width — no horizontal scroll)</div>');
            }
            productTracks.forEach(function (tr) {
                parts.push(renderTrack(tr, { fixed: true }));
            });
        }
        if (!usePremrnaScroll) {
            allTracks.forEach(function (tr) {
                parts.push(renderTrack(tr, { fixed: true }));
            });
        }
        parts.push('</div>');

        bodyEl.innerHTML = parts.join('');
        wireJunctionAlignScroll(payload);

        legEl.innerHTML = (payload.legend || []).map(function (lg) {
            const s = KIND_STYLE[lg.kind] || KIND_STYLE.intron;
            let swatch = 'background:' + s.bg + ';border:1px solid ' + s.border + ';';
            if (lg.kind === 'dup') {
                swatch = 'background:rgba(51,65,85,0.45);border-bottom:3px solid #ef4444;border-top:1px solid #475569;';
            }
            if (lg.kind === 'ptc') {
                swatch = 'background:rgba(239,68,68,0.4);border:2px solid #ef4444;';
            }
            return '<span><span style="display:inline-block;width:12px;height:10px;border-radius:2px;vertical-align:middle;'
                + swatch + 'margin-right:4px;"></span>' + esc(lg.label) + '</span>';
        }).join('');

        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    function closeJunctionAlignModal() {
        const modal = document.getElementById('junctionAlignModal');
        if (modal) {
            modal.style.display = 'none';
            document.body.style.overflow = '';
        }
    }

    function buildJunctionAlignLauncher(payload) {
        if (!payload || !payload.eligible) return '';
        if (!global.__jaPayloadStore) global.__jaPayloadStore = {};
        const storeId = 'ja_' + Math.random().toString(36).slice(2, 11);
        global.__jaPayloadStore[storeId] = payload;
        return '<button type="button" onclick="openJunctionAlignModal(window.__jaPayloadStore[\'' + storeId + '\'])" '
            + 'style="margin-top:10px;padding:8px 14px;border-radius:8px;border:1px solid #38bdf8;'
            + 'background:rgba(56,189,248,0.12);color:#7dd3fc;cursor:pointer;font-family:Outfit,system-ui,sans-serif;'
            + 'font-size:0.82rem;font-weight:600;">'
            + '&#128270; ' + esc(payload.launcher_label || 'Junction sequence map')
            + '</button>'
            + '<span style="display:block;margin-top:4px;font-size:0.72rem;color:#64748b;font-family:Outfit,sans-serif;">'
            + esc(payload.launcher_hint || 'Stacked tracks with HGVS ruler — all resolved cryptic splice products.')
            + '</span>';
    }

    global.openJunctionAlignModal = openJunctionAlignModal;
    global.closeJunctionAlignModal = closeJunctionAlignModal;
    global.buildJunctionAlignLauncher = buildJunctionAlignLauncher;
})(typeof window !== 'undefined' ? window : globalThis);
