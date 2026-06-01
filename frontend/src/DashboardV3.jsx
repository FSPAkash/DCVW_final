import React, { useState, useEffect, useCallback, useRef } from 'react';
import config from './config';
import { fetchWithRenderWake } from './network';

const API = config.API_URL || '';

// ============== helpers ==============
function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(d);
}
function signedFmt(n, d = 2) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  return (v >= 0 ? '+' : '') + v.toFixed(d);
}
async function downloadBlob(href, filename) {
  try {
    const res = await fetchWithRenderWake(href);
    if (!res.ok) throw new Error('download failed');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'download.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (e) {
    window.open(href, '_blank');
  }
}

function renderInlineMd(text, keyPrefix = 'i') {
  // Handle [label](url), then **bold**, then bare pdf urls
  const parts = [];
  const re = /\[([^\]]+)\]\((\S+?)\)|\*\*([^*]+)\*\*|((?:https?:\/\/|\/api\/v3\/master\/blend\/)\S+\.pdf)/g;
  let last = 0; let m; let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] && m[2]) {
      const cleanUrl = m[2].replace(/[)\].,;]+$/, '');
      const href = cleanUrl.startsWith('http') ? cleanUrl : `${API}${cleanUrl}`;
      const filename = cleanUrl.split('/').pop() || 'blend-card.pdf';
      parts.push(<a key={keyPrefix + i} href={href} className="anirudh-link"
        onClick={(e) => { e.preventDefault(); downloadBlob(href, filename); }}>{m[1]}</a>);
    } else if (m[3]) {
      parts.push(<b key={keyPrefix + i}>{m[3]}</b>);
    } else if (m[4]) {
      const cleanUrl = m[4].replace(/[)\].,;]+$/, '');
      const href = cleanUrl.startsWith('http') ? cleanUrl : `${API}${cleanUrl}`;
      const filename = cleanUrl.split('/').pop() || 'blend-card.pdf';
      parts.push(<a key={keyPrefix + i} href={href} className="anirudh-link"
        onClick={(e) => { e.preventDefault(); downloadBlob(href, filename); }}>Download</a>);
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderChatContent(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const blocks = [];
  let listBuf = [];
  const flushList = () => {
    if (listBuf.length) {
      blocks.push(
        <ul className="anirudh-list" key={'ul' + blocks.length}>
          {listBuf.map((item, idx) => (
            <li key={idx}>{renderInlineMd(item, `l${blocks.length}-${idx}-`)}</li>
          ))}
        </ul>
      );
      listBuf = [];
    }
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet) {
      listBuf.push(bullet[1]);
      return;
    }
    if (numbered) {
      listBuf.push(numbered[1]);
      return;
    }
    flushList();
    if (line.trim() === '') {
      blocks.push(<div className="anirudh-spacer" key={'sp' + idx} />);
    } else {
      blocks.push(<p className="anirudh-p" key={'p' + idx}>{renderInlineMd(line, `p${idx}-`)}</p>);
    }
  });
  flushList();
  return blocks;
}

async function api(path, opts = {}) {
  const r = await fetchWithRenderWake(`${API}/api/v3${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error || data?.message || `${r.status} ${r.statusText}`);
  return data;
}

function TestingTag({ compact = false }) {
  return <span className={'testing-tag' + (compact ? ' compact' : '')}>USER TESTING ONLY</span>;
}

function StatusBar({ screen, customer, ranked, qty, totals, user, onLogout }) {
  return (
    <div className="statusbar">
      <span className="dot"></span>
      <span>READY</span>
      <span className="sep"></span>
      <span>LOTS · {totals.lot_count || 0}</span>
      <span className="sep"></span>
      <span>STOCK · {fmt(totals.total_qty_mt || 0, 0)} MT</span>
      <span className="sep"></span>
      <span>USER · {user?.name || user?.username || '—'}</span>
      <div className="right">
        <span>SAHUPURAM · TN</span>
        <span className="sep"></span>
        <span className="status-powered">
          POWERED BY
          <img
            src="/logos/partner2.png"
            alt=""
            className="status-powered-logo"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
          FINDABILITY SCIENCES
        </span>
        <TestingTag compact />
        {onLogout && (
          <>
            <span className="sep"></span>
            <button className="status-signout" onClick={onLogout} title="Sign out">SIGN OUT</button>
          </>
        )}
      </div>
    </div>
  );
}

// ============== COA TARGET CARD ==============
function CoaTargetCard({ customer, onSaveOverride, onRevertOverride, locked }) {
  const [editing, setEditing] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState(false);
  const [draft, setDraft] = useState(null);
  const overridden = !!customer._overridden;
  const mt = customer.mass_tone || {};
  const rt = customer.tint_tone || {};

  function openPin() { setPin(''); setPinErr(false); setPinOpen(true); }
  async function submitPin(e) {
    e?.preventDefault();
    if (pin.length !== 4) return;
    sessionStorage.setItem('v3_pin', pin);
    setDraft({
      mt_DL: mt.DL ?? 0, mt_Da: mt.Da ?? 0, mt_Db: mt.Db ?? 0,
      rt_DL: rt.DL ?? 0, rt_Da: rt.Da ?? 0, rt_Db: rt.Db ?? 0,
      DE_max_mt: mt.DE_max ?? 1.3, DE_max_rt: rt.DE_max ?? 1.3,
      strength_lo: rt.strength_lo ?? 95, strength_hi: rt.strength_hi ?? 105,
    });
    setEditing(true);
    setPinOpen(false);
  }
  async function save() {
    const patch = {
      mass_tone: { DL: Number(draft.mt_DL), Da: Number(draft.mt_Da), Db: Number(draft.mt_Db), DE_max: Number(draft.DE_max_mt) },
      tint_tone: { DL: Number(draft.rt_DL), Da: Number(draft.rt_Da), Db: Number(draft.rt_Db), DE_max: Number(draft.DE_max_rt),
                    strength_lo: Number(draft.strength_lo), strength_hi: Number(draft.strength_hi) },
    };
    try {
      await onSaveOverride(patch, sessionStorage.getItem('v3_pin') || '');
      setEditing(false);
      setDraft(null);
    } catch (e) {
      setPinErr(true);
      setEditing(false);
      setDraft(null);
    }
  }
  function cancelEdit() { setEditing(false); setDraft(null); }
  async function revert() {
    try { await onRevertOverride(); } catch (_e) { /* silent */ }
    setEditing(false); setDraft(null);
  }
  function patch(k, v) { setDraft((d) => ({ ...d, [k]: v })); }

  return (
    <div className={'target-card' + (overridden ? ' overridden' : '') + (editing ? ' editing' : '')}>
      <div className="target-card-head">
        <span>COA Tint + Mass Targets</span>
        <span style={{ flex: 1 }}></span>
        {overridden && !editing && <span className="badge override">OVERRIDDEN</span>}
        {!overridden && !editing && <span className="badge">FROM COA</span>}
        {locked ? null : !editing ? (
          <button className="override-btn" onClick={openPin} title="Override (PIN)">
            <svg width="10" height="10" viewBox="0 0 12 12"><path d="M8 2 L10 4 L5 9 L2 10 L3 7 Z" stroke="currentColor" fill="none" strokeWidth="1.2"/></svg>
            Override
          </button>
        ) : (
          <span className="badge override blink">EDITING</span>
        )}
      </div>

      {!editing ? (
        <>
          <div style={{ marginBottom: 6, fontSize: 10.5, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Mass Tone</div>
          <div className="tgrid">
            <div className="pill"><span className="k">ΔL</span><span className="v">{signedFmt(mt.DL)}</span></div>
            <div className="pill"><span className="k">Δa</span><span className="v">{signedFmt(mt.Da)}</span></div>
            <div className="pill"><span className="k">Δb</span><span className="v">{signedFmt(mt.Db)}</span></div>
          </div>
          <div style={{ marginTop: 8, marginBottom: 6, fontSize: 10.5, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Tint Tone</div>
          <div className="tgrid">
            <div className="pill"><span className="k">ΔL</span><span className="v">{signedFmt(rt.DL)}</span></div>
            <div className="pill"><span className="k">Δa</span><span className="v">{signedFmt(rt.Da)}</span></div>
            <div className="pill"><span className="k">Δb</span><span className="v">{signedFmt(rt.Db)}</span></div>
          </div>
          <div className="tolerance-row">
            <div>
              <span>ΔE max</span>
              <b>{fmt(rt.DE_max || mt.DE_max)}</b>
            </div>
            <div>
              <span>Strength %</span>
              <b>{rt.strength_lo != null ? `${fmt(rt.strength_lo, 0)}–${fmt(rt.strength_hi, 0)}` : '—'}</b>
            </div>
          </div>
          {overridden && !locked && (
            <button className="revert-link" onClick={revert}>⟲ Revert to COA</button>
          )}
          {locked && (
            <div className="coa-locked-note">
              Cancel fulfillment and initiate a new lot match to override COA and edit required tests.
            </div>
          )}
        </>
      ) : (
        <div className="edit-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Mass Tone</div>
          <EditField label="MT ΔL" k="mt_DL" draft={draft} onChange={patch} signed />
          <EditField label="MT Δa" k="mt_Da" draft={draft} onChange={patch} signed />
          <EditField label="MT Δb" k="mt_Db" draft={draft} onChange={patch} signed />
          <EditField label="MT ΔEmax" k="DE_max_mt" draft={draft} onChange={patch} min={0} />
          <div style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 6 }}>Tint Tone</div>
          <EditField label="RT ΔL" k="rt_DL" draft={draft} onChange={patch} signed />
          <EditField label="RT Δa" k="rt_Da" draft={draft} onChange={patch} signed />
          <EditField label="RT Δb" k="rt_Db" draft={draft} onChange={patch} signed />
          <EditField label="RT ΔEmax" k="DE_max_rt" draft={draft} onChange={patch} min={0} />
          <div style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 6 }}>Tint Strength %</div>
          <EditField label="Str lo" k="strength_lo" draft={draft} onChange={patch} min={0} />
          <EditField label="Str hi" k="strength_hi" draft={draft} onChange={patch} min={0} />
          <div className="edit-actions" style={{ gridColumn: '1 / -1' }}>
            <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={save}>Save & re-rank</button>
          </div>
          <div className="tiny muted" style={{ gridColumn: '1 / -1' }}>
            Override re-ranks all lots and clears the current allocation.
          </div>
        </div>
      )}

      {pinOpen && (
        <div className="pin-overlay" onClick={() => setPinOpen(false)}>
          <form className="pin-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPin}>
            <div className="pin-header">
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7 V5 a4 4 0 0 1 8 0 V7 M3 7 H11 V13 H3 Z" stroke="currentColor" fill="none" strokeWidth="1.2"/></svg>
              <b>Supervisor PIN required</b>
            </div>
            <p className="tiny muted" style={{ margin: '6px 0 10px' }}>
              Enter the 4-digit override PIN.
            </p>
            <input
              autoFocus type="password" inputMode="numeric" maxLength={4}
              className={'pin-input' + (pinErr ? ' err' : '')}
              value={pin}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setPinErr(false); }}
              placeholder="• • • •"
            />
            {pinErr && <div className="pin-err">Incorrect PIN. Try again.</div>}
            <div className="pin-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPinOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={pin.length !== 4}>Unlock</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/**
 * Reusable PIN gate modal. Verifies the 4-digit PIN against the backend, then
 * calls `onConfirm(pin)` on success. Used to protect destructive actions.
 */
function PinPrompt({ open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setPin(''); setErr(false); setBusy(false); } }, [open]);
  if (!open) return null;
  async function submit(e) {
    e?.preventDefault();
    if (pin.length !== 4) return;
    setBusy(true);
    try {
      const r = await fetchWithRenderWake(`${API}/api/v3/verify_pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (!r.ok) { setErr(true); setBusy(false); return; }
      sessionStorage.setItem('v3_pin', pin);
      await onConfirm(pin);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pin-overlay" onClick={() => !busy && onCancel()}>
      <form className="pin-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="pin-header">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7 V5 a4 4 0 0 1 8 0 V7 M3 7 H11 V13 H3 Z" stroke="currentColor" fill="none" strokeWidth="1.2"/></svg>
          <b>{title || 'Supervisor PIN required'}</b>
        </div>
        {message && <p className="tiny muted" style={{ margin: '6px 0 10px', lineHeight: 1.5 }}>{message}</p>}
        <input
          autoFocus type="password" inputMode="numeric" maxLength={4}
          className={'pin-input' + (err ? ' err' : '')}
          value={pin}
          onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setErr(false); }}
          placeholder="• • • •"
        />
        {err && <div className="pin-err">Incorrect PIN. Try again.</div>}
        <div className="pin-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className={'btn btn-sm ' + (danger ? 'btn-danger' : 'btn-primary')} disabled={busy || pin.length !== 4}>
            {busy ? 'Verifying…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function EditField({ label, k, draft, onChange, signed, min }) {
  const v = draft[k];
  return (
    <label className="edit-field">
      <span className="k">{label}</span>
      <input type="number" step="0.01" min={min} value={v}
             onChange={(e) => onChange(k, e.target.value)} />
    </label>
  );
}

// ============== COA MINI on home ==============
function CoaMini({ customer }) {
  const mt = customer.mass_tone || {};
  const rt = customer.tint_tone || {};
  return (
    <div className="coa-mini">
      <div className="coa-mini-head">
        <span>COA · on file ({customer.latest_pdf})</span>
        <span style={{ flex: 1 }}></span>
        <span className="stamp">{customer.parsed_ok ? 'PARSED' : 'PARSE-FAIL'}</span>
      </div>
      <div className="row">
        <div className="pill"><span className="k">MT ΔL</span><span className="v">{signedFmt(mt.DL)}</span></div>
        <div className="pill"><span className="k">MT Δa</span><span className="v">{signedFmt(mt.Da)}</span></div>
        <div className="pill"><span className="k">MT Δb</span><span className="v">{signedFmt(mt.Db)}</span></div>
      </div>
      <div className="row">
        <div className="pill"><span className="k">RT ΔL</span><span className="v">{signedFmt(rt.DL)}</span></div>
        <div className="pill"><span className="k">RT Δa</span><span className="v">{signedFmt(rt.Da)}</span></div>
        <div className="pill"><span className="k">RT Δb</span><span className="v">{signedFmt(rt.Db)}</span></div>
      </div>
      <div className="row">
        <div className="pill"><span className="k">ΔE max</span><span className="v">{fmt(rt.DE_max || mt.DE_max)}</span></div>
        <div className="pill"><span className="k">Strength</span><span className="v">{rt.strength_lo != null ? `${fmt(rt.strength_lo,0)}–${fmt(rt.strength_hi,0)}` : '—'}</span></div>
        <div className="pill"><span className="k">Report</span><span className="v" style={{ fontSize: 10.5 }}>{customer.report_date || '—'}</span></div>
      </div>
    </div>
  );
}

// ============== HOME secondary panels ==============

function CustomerCombo({ id, customers, customerId, onSelect }) {
  const selected = customers.find((c) => c.id === customerId);
  const [text, setText] = useState(selected ? selected.name : '');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef(null);

  useEffect(() => {
    const s = customers.find((c) => c.id === customerId);
    if (s && s.name !== text) setText(s.name);
  }, [customerId, customers]);

  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const q = text.trim().toLowerCase();
  const matches = q
    ? customers.filter((c) => (c.name || '').toLowerCase().includes(q) || String(c.grade || '').toLowerCase().includes(q))
    : customers;
  const showList = open && matches.length > 0;

  const pick = (c) => { onSelect(c.id); setText(c.name); setOpen(false); };

  const onKey = (e) => {
    if (!open) { if (e.key === 'ArrowDown' || e.key === 'Enter') setOpen(true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(matches.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (matches[hi]) pick(matches[hi]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div className="combo" ref={wrapRef}>
      <input
        id={id}
        type="text"
        value={text}
        placeholder="— Select a customer —"
        onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        autoComplete="off"
      />
      {showList && (
        <div className="combo-list">
          {matches.slice(0, 50).map((c, i) => (
            <div
              key={c.id}
              className={'combo-item' + (i === hi ? ' hi' : '') + (c.id === customerId ? ' sel' : '')}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="combo-name">{c.name}</span>
              {c.grade && <span className="combo-grade">grade {c.grade}</span>}
              {!c.parsed_ok && <span className="combo-warn">⚠</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RequiredTestsField({ methods, requiredTests, onTests, compact }) {
  return (
    <div className="field">
      <label className="field-label">
        Required tests {compact ? '' : '(filter — MT + RT always required)'}
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(methods || []).map((m) => {
          const checked = requiredTests.includes(m);
          const isBase = m === 'Method I a' || m === 'Method I b';
          return (
            <button type="button" key={m}
              onClick={() => isBase ? null : onTests(checked ? requiredTests.filter((x) => x !== m) : [...requiredTests, m])}
              className={'chip' + (checked || isBase ? ' accent' : '')}
              style={{ cursor: isBase ? 'default' : 'pointer', opacity: isBase ? 0.85 : 1 }}
              title={isBase ? 'Required for matching' : ''}>
              {m}{isBase ? ' ✓' : ''}
            </button>
          );
        })}
      </div>
      {!compact && <span className="field-hint">Lots missing any checked test are excluded from results.</span>}
    </div>
  );
}

// ============== HOME ==============
function HomeScreen({ customers, master, user, customerId, qty, requiredTests, gradeStrict, onSelect, onQty, onTests, onGradeStrict, onMatch, coaPreview, loadingPreview, onEditFulfillment, onReloadMaster, tab, onTabChange, masterLock }) {
  const dups = master.duplicates || [];
  const setTab = onTabChange;
  return (
    <div className="home home-v2">
      <div className="home-topbar">
        <div className="home-title-block">
          <div className="home-eyebrow">
            <span className="bar"></span>
            <span>Sales · Inventory · Operations Planning</span>
          </div>
          <h1 className="home-title">Inventory Match Matrix</h1>
        </div>
        <div className="home-tabs-bar">
          <button className={'home-tab' + (tab === 'new' ? ' active' : '')} onClick={() => setTab('new')}>
            <span className="home-tab-num">01</span>
            <span className="home-tab-label">New requirement</span>
          </button>
          <button className={'home-tab' + (tab === 'recent' ? ' active' : '')} onClick={() => setTab('recent')}>
            <span className="home-tab-num">02</span>
            <span className="home-tab-label">Recent fulfillments</span>
          </button>
          <button className={'home-tab' + (tab === 'blending' ? ' active' : '')} onClick={() => setTab('blending')}>
            <span className="home-tab-num">03</span>
            <span className="home-tab-label">Blending</span>
          </button>
          <button className={'home-tab' + (tab === 'master' ? ' active' : '')} onClick={() => setTab('master')}>
            <span className="home-tab-num">04</span>
            <span className="home-tab-label">Master overview</span>
          </button>
        </div>
      </div>

      {tab === 'new' && (
        <div className="home-tab-new">
          <aside className="home-tab-new-side">
            <div className="home-stats">
              <div className="stat">
                <div className="label">Available</div>
                <div className="value">{(master.totals?.total_qty_mt || 0).toFixed(0)}<span className="unit"> MT</span></div>
              </div>
              <div className="stat">
                <div className="label">Lots</div>
                <div className="value">{master.totals?.lot_count || 0}</div>
              </div>
            </div>
            {dups.length > 0 && (
              <div className="home-error-card">
                <div className="home-error-head">
                  <span className="home-error-tag">DATA ISSUE</span>
                  <span className="home-error-title">{dups.length} duplicate lot code{dups.length === 1 ? '' : 's'} in Master</span>
                </div>
                <p className="home-error-body">Fix in Master.xlsx. Matching will skip duplicates until resolved.</p>
                <div className="home-error-list">
                  {dups.map((d) => (
                    <span key={`${d.lot_no}@${d.col_letter}`} className="home-error-pill">
                      {d.lot_no}<span className="muted">@{d.col_letter}</span> · {d.qty_mt} MT
                    </span>
                  ))}
                </div>
              </div>
            )}
          </aside>

        <div className="input-panel">
          <span className="corner tl"></span>
          <span className="corner tr"></span>
          <span className="corner bl"></span>
          <span className="corner br"></span>
          <div className="input-panel-inner">
            <div className="input-panel-header">
              <h2>Enter Customer Requirements</h2>
              <span className="sub">REQ-{new Date().getFullYear()}-{String(Math.floor(Math.random()*900)+100)}</span>
            </div>
            <form className="input-panel-form" onSubmit={(e) => { e.preventDefault(); if (customerId) onMatch(); }}>
              <div className="field">
                <label className="field-label" htmlFor="cust">Customer</label>
                <CustomerCombo id="cust" customers={customers} customerId={customerId} onSelect={onSelect} />
                <span className="field-hint">Type to search · COA parsed from backend/COA/&lt;customer&gt;/ PDFs. Newest selected.</span>
              </div>

              <div className="qty-row">
                <div className="field">
                  <label className="field-label" htmlFor="qty">Quantity Required</label>
                  <div className="qty-input-wrap">
                    <input id="qty" type="number" min="0" step="0.5" value={qty}
                           onChange={(e) => onQty(e.target.value)} placeholder="0.0" />
                    <span className="unit">MT</span>
                  </div>
                </div>
                <div className="field" style={{ minWidth: 140 }}>
                  <label className="field-label">Grade (COA)</label>
                  <div style={{ height: 36, display: 'flex', alignItems: 'center', paddingLeft: 10,
                                border: '1px dashed var(--line)', borderRadius: 4,
                                background: 'var(--bg-stripe)', fontFamily: 'var(--font-mono)' }}>
                    {coaPreview?.grade || '—'}
                  </div>
                </div>
              </div>

              <RequiredTestsField methods={master.methods || []} requiredTests={requiredTests} onTests={onTests} />


              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={gradeStrict} onChange={(e) => onGradeStrict(e.target.checked)} />
                  <span className="field-label" style={{ margin: 0 }}>Strict grade match (lot grade must equal COA grade)</span>
                </label>
              </div>

              {customerId && coaPreview && <CoaMini customer={coaPreview} />}
              {customerId && loadingPreview && <div className="tiny muted">Loading COA…</div>}

              <div className="run-row">
                <span className="tiny muted">{master.totals?.lot_count || 0} lots in Master</span>
                <button type="submit" className="btn btn-primary"
                        title={masterLock?.locked ? 'Master.xlsx is being edited — matching disabled' : ''}
                        disabled={!customerId || !qty || Number(qty) <= 0 || !!masterLock?.locked}>
                  {masterLock?.locked ? 'Offline · master in use' : 'Match Available Lots'}
                  {!masterLock?.locked && <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7 H11 M8 4 L11 7 L8 10" stroke="currentColor" fill="none" strokeWidth="1.4"/></svg>}
                </button>
              </div>
            </form>
          </div>
        </div>
        </div>
      )}

      {tab === 'recent' && (
        <div className="home-tab-full"><RecentFulfillments onEditFulfillment={onEditFulfillment} /></div>
      )}

      {tab === 'master' && (
        <div className="home-tab-full"><MasterOverview master={master} user={user} masterLock={masterLock} onReloadMaster={onReloadMaster} /></div>
      )}

      {tab === 'blending' && (
        <div className="home-tab-full"><BlendingTab master={master} user={user} onReloadMaster={onReloadMaster} masterLock={masterLock} /></div>
      )}
    </div>
  );
}

function BlendingTab({ master, user, onReloadMaster, masterLock }) {
  const lots = (master.lots || []).filter((l) => (l.qty_mt || 0) > 0);
  const methods = master.methods || [];
  const methodAxes = master.method_axes || {};
  const [selected, setSelected] = useState({}); // lot_id -> mt_used
  const [output, setOutput] = useState({ grade: '', lot_no: '', qty_mt: '' });
  const [values, setValues] = useState({}); // method -> axis -> value
  const [search, setSearch] = useState('');
  const [activeMethod, setActiveMethod] = useState(methods[0] || '');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [smartApplied, setSmartApplied] = useState(false);
  const [expandedLot, setExpandedLot] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [qtyAuto, setQtyAuto] = useState(false);

  // Auto-sync output qty to totalSelected unless user typed it manually
  useEffect(() => {
    if (qtyAuto || output.qty_mt === '' || output.qty_mt == null) {
      setOutput((o) => ({ ...o, qty_mt: totalSelected > 0 ? totalSelected : '' }));
      setQtyAuto(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(selected)]);
  const [gradeFilter, setGradeFilter] = useState('');
  const [mtDeMin, setMtDeMin] = useState('');
  const [mtDeMax, setMtDeMax] = useState('');
  const [rtDeMin, setRtDeMin] = useState('');
  const [rtDeMax, setRtDeMax] = useState('');
  const [strMin, setStrMin] = useState('');
  const [strMax, setStrMax] = useState('');
  const [qtyMin, setQtyMin] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!activeMethod && methods.length) setActiveMethod(methods[0]);
  }, [methods, activeMethod]);

  const selectedAll = Object.entries(selected)
    .map(([lot_id, mt]) => ({ lot_id, mt_used: Number(mt) || 0 }));
  const selectedList = selectedAll.filter((s) => s.mt_used > 0);
  const totalSelected = selectedList.reduce((acc, s) => acc + s.mt_used, 0);

  const lotById = {};
  for (const l of master.lots || []) lotById[l.lot_id] = l;

  function toggleLot(lot) {
    setSelected((cur) => {
      const next = { ...cur };
      if (next[lot.lot_id] !== undefined) {
        delete next[lot.lot_id];
      } else {
        next[lot.lot_id] = '';
      }
      return next;
    });
  }
  function setMt(lot_id, v) {
    setSelected((cur) => ({ ...cur, [lot_id]: v }));
  }
  function setVal(method, axis, v) {
    setValues((cur) => ({ ...cur, [method]: { ...(cur[method] || {}), [axis]: v } }));
  }

  async function runAutoPreview() {
    if (selectedList.length === 0) return;
    setPreviewLoading(true);
    try {
      const res = await fetchWithRenderWake(`${API}/api/v3/master/blend/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: selectedList }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'preview failed');
      setValues(data.methods || {});
      setOutput((o) => ({ ...o, qty_mt: data.qty_mt }));
      setQtyAuto(true);
      setSmartApplied(true);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setPreviewLoading(false);
    }
  }

  const overAlloc = selectedList.filter((s) => {
    const lot = lotById[s.lot_id];
    return lot && s.mt_used > (lot.qty_mt || 0) + 1e-6;
  });
  const hasOverAlloc = overAlloc.length > 0;

  function openConfirm() {
    setError('');
    setResult(null);
    if (selectedList.length === 0) { setError('Pick at least one source lot.'); return; }
    if (hasOverAlloc) {
      const names = overAlloc.map((s) => lotById[s.lot_id]?.lot_no || s.lot_id).join(', ');
      setError(`MT used exceeds available inventory for: ${names}`); return;
    }
    if (!output.grade.trim() || !output.lot_no.trim()) { setError('Grade and Lot # required.'); return; }
    if (!output.qty_mt || Number(output.qty_mt) <= 0) { setError('Output qty must be > 0.'); return; }
    const requiredMethods = ['Method I a', 'Method I b'];
    for (const m of requiredMethods) {
      const axes = methodAxes[m] || [];
      for (const a of axes) {
        const v = (values[m] || {})[a];
        if (v === undefined || v === null || v === '') {
          setError(`Missing required value for ${m} · ${a}.`); return;
        }
      }
    }
    setConfirmOpen(true);
  }

  function proceedToPin() {
    setConfirmOpen(false);
    setPin(''); setPinErr(false); setPinOpen(true);
  }

  async function submitBlend(e) {
    e?.preventDefault();
    if (pin.length !== 4) { setPinErr(true); return; }
    setSubmitting(true);
    try {
      const payload = {
        sources: selectedList,
        output: {
          grade: output.grade.trim(),
          lot_no: output.lot_no.trim(),
          qty_mt: Number(output.qty_mt),
          methods: values,
        },
      };
      const res = await fetchWithRenderWake(`${API}/api/v3/master/blend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, payload, user: user?.name || user?.username || 'operator' }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 403) { setPinErr(true); return; }
        throw new Error(data?.error || 'blend failed');
      }
      setResult(data.record);
      setPinOpen(false);
      setSelected({});
      setOutput({ grade: '', lot_no: '', qty_mt: '' });
      setValues({});
      setSmartApplied(false);
      setQtyAuto(false);
      if (typeof onReloadMaster === 'function') {
        try { await onReloadMaster(); } catch (_) {}
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSubmitting(false);
    }
  }

  const grades = Array.from(new Set(lots.map((l) => l.grade || '—'))).sort();
  const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

  function lotPassesFilters(l) {
    if (gradeFilter && (l.grade || '—') !== gradeFilter) return false;
    const mtDe = ((l.blocks || {})['Method I a'] || {}).DE;
    const rtDe = ((l.blocks || {})['Method I b'] || {}).DE;
    const str = ((l.blocks || {})['Method I b'] || {}).Strength;
    const a = numOrNull(mtDeMin), b = numOrNull(mtDeMax);
    const c = numOrNull(rtDeMin), d = numOrNull(rtDeMax);
    const sLo = numOrNull(strMin), sHi = numOrNull(strMax);
    const qMin = numOrNull(qtyMin);
    if (a != null && (mtDe == null || mtDe < a)) return false;
    if (b != null && (mtDe == null || mtDe > b)) return false;
    if (c != null && (rtDe == null || rtDe < c)) return false;
    if (d != null && (rtDe == null || rtDe > d)) return false;
    if (sLo != null && (str == null || str < sLo)) return false;
    if (sHi != null && (str == null || str > sHi)) return false;
    if (qMin != null && (l.qty_mt == null || l.qty_mt < qMin)) return false;
    return true;
  }

  const candidates = lots
    .filter((l) => selected[l.lot_id] === undefined)
    .filter(lotPassesFilters);

  const matches = (search.trim()
    ? candidates.filter((l) => {
        const q = search.toLowerCase();
        return (l.lot_no || '').toLowerCase().includes(q) || (l.grade || '').toLowerCase().includes(q);
      })
    : candidates
  ).slice(0, 8);
  const totalCandidates = candidates.length;

  function pickLot(lot) {
    setSelected((cur) => ({ ...cur, [lot.lot_id]: '' }));
    setSearch('');
  }
  function removeLot(lot_id) {
    setSelected((cur) => {
      const next = { ...cur };
      delete next[lot_id];
      return next;
    });
  }

  // Always show all methods so user can fill values for missing data too
  const activeMethods = methods;
  const methodForAxes = activeMethod && activeMethods.includes(activeMethod) ? activeMethod : activeMethods[0];
  const axesForActive = (methodForAxes && (methodAxes[methodForAxes] || [])) || [];

  function axisStats(method, axis) {
    const vals = selectedAll
      .map((s) => (lotById[s.lot_id]?.blocks?.[method] || {})[axis])
      .filter((v) => v != null);
    if (!vals.length) return null;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    let num = 0, denom = 0;
    selectedList.forEach((s) => {
      const v = (lotById[s.lot_id]?.blocks?.[method] || {})[axis];
      if (v != null && s.mt_used > 0) { num += v * s.mt_used; denom += s.mt_used; }
    });
    const wavg = denom > 0 ? num / denom : null;
    return { min, max, wavg };
  }

  return (
    <div className="blend-page">
      <div className="blend-head">
        <div>
          <h2>Blending</h2>
          <p className="tiny muted">Add source lots, set MT used, define blended output, save to Master.</p>
        </div>
        <div className="blend-totals">
          <div><span className="lbl">Sources</span><b>{selectedList.length}</b></div>
          <div><span className="lbl">Total used</span><b>{fmt(totalSelected, 2)} MT</b></div>
          <div><span className="lbl">Output qty</span><b>{output.qty_mt ? fmt(Number(output.qty_mt), 2) : '—'} MT</b></div>
        </div>
      </div>

      {result && (
        <div className="blend-success">
          Blended lot <b>{result.output.lot_no}</b> (grade {result.output.grade}, {fmt(result.output.qty_mt, 2)} MT) added to Master. Reload to see in overview.
        </div>
      )}
      {error && <div className="blend-error">{error}</div>}

      <div className="blend-layout">
      {/* Sources side rail */}
      <aside className="blend-side">
        <div className="blend-sources">
          <div className="blend-sources-head">
            <span>Source lots</span>
          </div>
          <div className="blend-sources-body">
            <button type="button" className="btn btn-primary blend-add-btn" onClick={() => setPickerOpen(true)}>
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2 V10 M2 6 H10" stroke="currentColor" strokeWidth="1.6" fill="none"/></svg>
              Add source lot
            </button>
            <div className="blend-chip-rail">
              {Object.keys(selected).length === 0 && <div className="tiny muted blend-empty">No sources yet. Click "Add source lot".</div>}
              {Object.keys(selected).map((lid) => {
                const lot = lotById[lid];
                if (!lot) return null;
                const expanded = expandedLot === lid;
                const used = Number(selected[lid]) || 0;
                const remaining = (lot.qty_mt || 0) - used;
                const over = used > (lot.qty_mt || 0) + 1e-6;
                return (
                  <div key={lid} className={'blend-chip-src' + (expanded ? ' expanded' : '') + (over ? ' over' : '')}>
                    <div className="blend-chip-row">
                      <button type="button" className="blend-chip-toggle" onClick={() => setExpandedLot(expanded ? null : lid)} aria-label="toggle">
                        <svg width="10" height="10" viewBox="0 0 10 10" style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}><path d="M3 2 L7 5 L3 8" stroke="currentColor" strokeWidth="1.4" fill="none"/></svg>
                      </button>
                      <div className="blend-chip-info">
                        <b>{lot.lot_no}</b>
                        <span className="muted">{lot.grade} · {fmt(lot.qty_mt, 2)} MT avail</span>
                        {used > 0 && !over && (
                          <span className="tiny" style={{ color: 'var(--accent-ink)' }}>→ {fmt(remaining, 2)} MT after</span>
                        )}
                        {over && (
                          <span className="tiny" style={{ color: 'var(--err)' }}>over by {fmt(used - (lot.qty_mt || 0), 2)} MT</span>
                        )}
                      </div>
                      <input
                        type="number" min="0" max={lot.qty_mt} step="0.1"
                        value={selected[lid]}
                        onChange={(e) => setMt(lid, e.target.value)}
                        placeholder="MT"
                      />
                      <button type="button" className="blend-chip-x" onClick={() => removeLot(lid)} aria-label="remove">×</button>
                    </div>
                    {expanded && (
                      <div className="blend-chip-detail">
                        {methods.map((m) => {
                          const blk = (lot.blocks || {})[m] || {};
                          const axes = methodAxes[m] || [];
                          const hasAny = axes.some((a) => blk[a] != null);
                          if (!hasAny) return null;
                          return (
                            <div key={m} className="blend-chip-method">
                              <div className="blend-chip-method-name">{m}</div>
                              <div className="blend-chip-method-axes">
                                {axes.map((a) => (
                                  <div key={a} className="blend-chip-axis">
                                    <span>{a}</span>
                                    <b>{blk[a] == null ? '—' : fmt(blk[a], 3)}</b>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </aside>

      {/* Blended output workspace */}
      <section className="blend-workspace">
        <div className="blend-workspace-head">
          <div className="blend-identity">
            <div className="blend-field">
              <label>Grade</label>
              <input type="text" value={output.grade} onChange={(e) => setOutput((o) => ({ ...o, grade: e.target.value }))} placeholder="e.g. BL-A" />
            </div>
            <div className="blend-field">
              <label>Lot #</label>
              <input type="text" value={output.lot_no} onChange={(e) => setOutput((o) => ({ ...o, lot_no: e.target.value }))} placeholder="e.g. BL-001" />
            </div>
            <div className="blend-field">
              <label>Qty (MT)</label>
              <input type="number" min="0" step="0.1" value={output.qty_mt} onChange={(e) => { setQtyAuto(false); setOutput((o) => ({ ...o, qty_mt: e.target.value })); }} placeholder="0.0" />
            </div>
          </div>
          <button type="button" className="smart-blend-btn" disabled={selectedList.length === 0 || previewLoading} onClick={runAutoPreview}>
            <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M9 1.5 10.7 6l4.8 1.7-4.8 1.6L9 13.8 7.3 9.3 2.5 7.7 7.3 6 9 1.5Z" fill="currentColor" />
            </svg>
            <span>{previewLoading ? 'Computing…' : (smartApplied ? 'Re-run smart blend' : 'Smart blend')}</span>
            <span className="smart-beta">BETA</span>
          </button>
        </div>

        <div className="blend-method-tabs">
          {activeMethods.map((m) => {
            const req = m === 'Method I a' || m === 'Method I b';
            return (
              <button
                type="button"
                key={m}
                className={'blend-method-tab' + (m === methodForAxes ? ' active' : '') + (req ? ' required' : '')}
                onClick={() => setActiveMethod(m)}
              >
                {m}{req && <span className="blend-req-dot" aria-label="required">*</span>}
              </button>
            );
          })}
        </div>

        <div className="blend-axes-pane">
          {axesForActive.length === 0 && <div className="tiny muted" style={{ padding: 16 }}>No axes for this method.</div>}
          {axesForActive.map((ax) => {
            const stats = smartApplied ? axisStats(methodForAxes, ax) : null;
            const val = (values[methodForAxes] || {})[ax] ?? '';
            return (
              <div key={ax} className="blend-axis-row">
                <div className="blend-axis-label">{ax}</div>
                <input
                  className="blend-axis-input"
                  type="number" step="0.0001"
                  value={val}
                  onChange={(e) => setVal(methodForAxes, ax, e.target.value)}
                  placeholder="0.0000"
                />
                {smartApplied && (
                  <div className="blend-axis-stats">
                    {stats ? (
                      <>
                        <span>min <b>{fmt(stats.min, 3)}</b></span>
                        <span>max <b>{fmt(stats.max, 3)}</b></span>
                        <span>wt-avg <b>{stats.wavg == null ? '—' : fmt(stats.wavg, 3)}</b></span>
                      </>
                    ) : (
                      <span className="muted">no source data</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="blend-actions results-footer">
          <div className="sticky-footer-text">
            <span className="tiny muted">BLEND</span>
            <b className="num">{fmt(totalSelected, 2)} MT</b>
            <span className="tiny muted">→ {output.qty_mt ? fmt(Number(output.qty_mt), 2) : '—'} MT output · {selectedList.length} source{selectedList.length === 1 ? '' : 's'}</span>
            {hasOverAlloc && <span className="chip err">over inventory</span>}
            {!hasOverAlloc && selectedList.length > 0 && <span className="chip ok">in range</span>}
            <TestingTag compact />
          </div>
          <button className="btn btn-primary" type="button" onClick={openConfirm}
                  title={masterLock?.locked ? 'Master.xlsx is being edited — blending disabled' : ''}
                  disabled={hasOverAlloc || selectedList.length === 0 || !!masterLock?.locked}>
            {!masterLock?.locked && <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6 L5 9 L10 3" stroke="currentColor" fill="none" strokeWidth="1.6"/></svg>}
            {masterLock?.locked ? 'Offline · master in use' : `Commit · ${fmt(Number(output.qty_mt) || 0, 1)} MT`}
          </button>
        </div>
      </section>
      </div>

      {confirmOpen && (
        <div className="pin-overlay" onClick={() => setConfirmOpen(false)}>
          <div className="pin-dialog blend-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="pin-header">
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2 V8 M7 11 V11.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round"/><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
              <span>Confirm blend · master will be modified</span>
            </div>
            <div className="blend-confirm-body">
              <div className="blend-confirm-section">
                <span className="field-label">New blended lot</span>
                <div className="blend-confirm-row">
                  <b>{output.lot_no}</b> · grade {output.grade} · {fmt(Number(output.qty_mt) || 0, 2)} MT
                </div>
              </div>
              <div className="blend-confirm-section">
                <span className="field-label">Inventory changes</span>
                <table className="blend-confirm-table">
                  <thead><tr><th>Lot</th><th className="num">Before</th><th className="num">Used</th><th className="num">After</th></tr></thead>
                  <tbody>
                    {selectedList.map((s) => {
                      const lot = lotById[s.lot_id];
                      if (!lot) return null;
                      const after = (lot.qty_mt || 0) - s.mt_used;
                      return (
                        <tr key={s.lot_id}>
                          <td><b>{lot.lot_no}</b> <span className="muted">@{lot.col_letter}</span></td>
                          <td className="num mono">{fmt(lot.qty_mt, 2)}</td>
                          <td className="num mono" style={{ color: 'var(--err)' }}>-{fmt(s.mt_used, 2)}</td>
                          <td className="num mono" style={{ color: 'var(--accent-ink)' }}>{fmt(after, 2)}</td>
                        </tr>
                      );
                    })}
                    <tr className="blend-confirm-new">
                      <td><b>{output.lot_no}</b> <span className="muted">(new)</span></td>
                      <td className="num mono muted">—</td>
                      <td className="num mono" style={{ color: 'var(--ok)' }}>+{fmt(Number(output.qty_mt) || 0, 2)}</td>
                      <td className="num mono" style={{ color: 'var(--ok)' }}>{fmt(Number(output.qty_mt) || 0, 2)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="tiny muted">Master.xlsx will be edited: source lot quantities reduced and a new column added for the blended lot. PIN required to proceed.</p>
            </div>
            <div className="pin-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={proceedToPin}
                      title={masterLock?.locked ? 'Master.xlsx is being edited' : ''}
                      disabled={!!masterLock?.locked}>
                {masterLock?.locked ? 'Offline · master in use' : 'Continue · enter PIN'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pickerOpen && (
        <div className="pin-overlay" onClick={() => setPickerOpen(false)}>
          <div className="blend-picker" onClick={(e) => e.stopPropagation()}>
            <div className="blend-picker-head">
              <div>
                <h3>Add source lots</h3>
                <span className="tiny muted">{totalCandidates} of {lots.length} match filters · {Object.keys(selected).length} selected</span>
              </div>
              <button type="button" className="blend-chip-x" onClick={() => setPickerOpen(false)} aria-label="close">×</button>
            </div>
            <div className="blend-picker-filters">
              <div className="field">
                <label className="field-label">Search</label>
                <input type="text" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Lot # or grade" />
              </div>
              <div className="field">
                <label className="field-label">Grade</label>
                <select value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
                  <option value="">All</option>
                  {grades.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="field-label">Method I a · DE</label>
                <div className="range-pair">
                  <input type="number" step="0.01" placeholder="min" value={mtDeMin} onChange={(e) => setMtDeMin(e.target.value)} />
                  <input type="number" step="0.01" placeholder="max" value={mtDeMax} onChange={(e) => setMtDeMax(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label className="field-label">Method I b · DE</label>
                <div className="range-pair">
                  <input type="number" step="0.01" placeholder="min" value={rtDeMin} onChange={(e) => setRtDeMin(e.target.value)} />
                  <input type="number" step="0.01" placeholder="max" value={rtDeMax} onChange={(e) => setRtDeMax(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label className="field-label">Method I b · Strength</label>
                <div className="range-pair">
                  <input type="number" step="0.01" placeholder="min" value={strMin} onChange={(e) => setStrMin(e.target.value)} />
                  <input type="number" step="0.01" placeholder="max" value={strMax} onChange={(e) => setStrMax(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label className="field-label">Min qty (MT)</label>
                <input type="number" step="0.1" placeholder="0.0" value={qtyMin} onChange={(e) => setQtyMin(e.target.value)} />
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => {
                setGradeFilter(''); setMtDeMin(''); setMtDeMax(''); setRtDeMin(''); setRtDeMax('');
                setStrMin(''); setStrMax(''); setQtyMin(''); setSearch('');
              }}>Reset</button>
            </div>
            <div className="blend-picker-list">
              <table className="blend-picker-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Lot</th>
                    <th>Grade</th>
                    <th className="num">Qty (MT)</th>
                    <th className="num">I a · DE</th>
                    <th className="num">I b · DE</th>
                    <th className="num">I b · Str</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((l) => {
                    const mtDe = ((l.blocks || {})['Method I a'] || {}).DE;
                    const rtDe = ((l.blocks || {})['Method I b'] || {}).DE;
                    const str = ((l.blocks || {})['Method I b'] || {}).Strength;
                    return (
                      <tr key={l.lot_id} className="blend-picker-row" onClick={() => pickLot(l)}>
                        <td><button type="button" className="btn btn-ghost blend-picker-add" onClick={(e) => { e.stopPropagation(); pickLot(l); }}>Add</button></td>
                        <td><b>{l.lot_no}</b> <span className="muted">@{l.col_letter}</span></td>
                        <td>{l.grade || '—'}</td>
                        <td className="num mono">{fmt(l.qty_mt, 2)}</td>
                        <td className="num mono">{mtDe == null ? '—' : fmt(mtDe, 2)}</td>
                        <td className="num mono">{rtDe == null ? '—' : fmt(rtDe, 2)}</td>
                        <td className="num mono">{str == null ? '—' : fmt(str, 1)}</td>
                      </tr>
                    );
                  })}
                  {candidates.length === 0 && (
                    <tr><td colSpan="7" className="tiny muted" style={{ textAlign: 'center', padding: 20 }}>No lots match filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="blend-picker-foot">
              <button type="button" className="btn btn-primary" onClick={() => setPickerOpen(false)}>Done · {Object.keys(selected).length} selected</button>
            </div>
          </div>
        </div>
      )}

      {pinOpen && (
        <div className="pin-overlay" onClick={() => setPinOpen(false)}>
          <form className="pin-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitBlend}>
            <div className="pin-header">
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7 V5 a4 4 0 0 1 8 0 V7 M3 7 H11 V13 H3 Z" stroke="currentColor" fill="none" strokeWidth="1.2"/></svg>
              <span>Supervisor PIN Required</span>
            </div>
            <p className="tiny muted" style={{ margin: '6px 0 10px' }}>Enter the 4-digit override PIN.</p>
            <input autoFocus type="password" inputMode="numeric" maxLength={4}
              className={'pin-input' + (pinErr ? ' err' : '')}
              value={pin}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setPinErr(false); }} />
            {pinErr && <div className="pin-err">Invalid PIN.</div>}
            <div className="pin-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setPinOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary"
                      title={masterLock?.locked ? 'Master.xlsx is being edited' : ''}
                      disabled={submitting || pin.length !== 4 || !!masterLock?.locked}>
                {submitting ? 'Saving…' : masterLock?.locked ? 'Offline · master in use' : 'Confirm blend'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function MasterOverview({ master, user, masterLock, onReloadMaster }) {
  const [openingMaster, setOpeningMaster] = useState(false);
  const [openError, setOpenError] = useState(null);
  const [pinForEdit, setPinForEdit] = useState(false);
  const [runtimeInfo, setRuntimeInfo] = useState({
    render: false,
    master_edit_mode: 'hybrid',
    supports_local_open: true,
    supports_master_upload: true,
  });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadingMaster, setUploadingMaster] = useState(false);
  const [uploadPin, setUploadPin] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [uploadNotice, setUploadNotice] = useState(null);
  const [gradesExpanded, setGradesExpanded] = useState(false);
  const uploadInputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api('/runtime')
      .then((info) => {
        if (!cancelled) setRuntimeInfo((prev) => ({ ...prev, ...info }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function doOpenMaster() {
    setOpenError(null);
    setUploadNotice(null);
    setOpeningMaster(true);
    try {
      const r = await fetchWithRenderWake(`${API}/api/v3/master/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: sessionStorage.getItem('v3_pin') || '' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `${r.status}`);
    } catch (e) {
      setOpenError(String(e.message || e));
    } finally {
      setOpeningMaster(false);
    }
  }

  async function downloadMaster() {
    setOpenError(null);
    setUploadNotice(null);
    await downloadBlob(`${API}/api/v3/master/file`, 'Master.xlsx');
  }

  function closeUploadModal() {
    setUploadOpen(false);
    setUploadPin('');
    setUploadFile(null);
    setUploadError(null);
    if (uploadInputRef.current) uploadInputRef.current.value = '';
  }

  async function submitMasterUpload(e) {
    e?.preventDefault();
    if (!uploadFile) {
      setUploadError('Choose the edited .xlsx file first.');
      return;
    }
    if (uploadPin.length !== 4) {
      setUploadError('Enter the 4-digit supervisor PIN.');
      return;
    }

    setUploadingMaster(true);
    setUploadError(null);
    setOpenError(null);
    setUploadNotice(null);

    try {
      const formData = new FormData();
      formData.append('pin', uploadPin);
      formData.append('file', uploadFile);

      const r = await fetchWithRenderWake(`${API}/api/v3/master/file`, {
        method: 'POST',
        body: formData,
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || d?.message || `${r.status} ${r.statusText}`);

      closeUploadModal();
      setUploadNotice(
        d?.backup_file
          ? `Workbook uploaded. Previous copy backed up as ${d.backup_file}.`
          : (d?.message || 'Workbook uploaded successfully.')
      );
      if (onReloadMaster) {
        try {
          await onReloadMaster();
        } catch (reloadErr) {
          setOpenError(String(reloadErr.message || reloadErr));
        }
      }
    } catch (err) {
      setUploadError(String(err.message || err));
    } finally {
      setUploadingMaster(false);
    }
  }

  const lots = master.lots || [];
  const gradeAgg = {};
  for (const l of lots) {
    const g = (l.grade || '—').toString();
    if (!gradeAgg[g]) gradeAgg[g] = { lots: 0, mt: 0, depleted: 0, largest: null };
    gradeAgg[g].lots += 1;
    gradeAgg[g].mt += l.qty_mt || 0;
    if ((l.qty_mt || 0) <= 0) gradeAgg[g].depleted += 1;
    if (!gradeAgg[g].largest || (l.qty_mt || 0) > (gradeAgg[g].largest.qty_mt || 0)) {
      gradeAgg[g].largest = l;
    }
  }
  const gradeRows = Object.entries(gradeAgg).sort((a, b) => b[1].mt - a[1].mt);
  const totalQty = lots.reduce((s, l) => s + (l.qty_mt || 0), 0);
  const activeCount = lots.filter((l) => (l.qty_mt || 0) > 0).length;

  const lowStock = lots.filter((l) => l.qty_mt > 0 && l.qty_mt <= 2).sort((a, b) => a.qty_mt - b.qty_mt);
  const recentEdits = lots.filter((l) => l.last_edited).sort((a, b) => (b.last_edited || '').localeCompare(a.last_edited || ''));
  const depleted = lots.filter((l) => (l.qty_mt || 0) <= 0);
  const duplicates = master.duplicates || [];

  const visibleGrades = gradesExpanded ? gradeRows : gradeRows.slice(0, 6);
  const showLocalOpen = !!runtimeInfo.supports_local_open;
  const downloadUploadOnly = runtimeInfo.master_edit_mode === 'download-upload';

  return (
    <div className="mo">
      {/* Stats strip */}
      <div className="mo-stats">
        <div className="mo-stat"><b>{fmt(totalQty, 0)}</b><span className="tiny muted"> MT total</span></div>
        <span className="mo-stat-sep">·</span>
        <div className="mo-stat"><b>{activeCount}</b><span className="tiny muted">/{lots.length} active lots</span></div>
        <span className="mo-stat-sep">·</span>
        <div className="mo-stat"><b>{gradeRows.length}</b><span className="tiny muted"> grades</span></div>
        <span className="mo-stat-sep">·</span>
        <div className="mo-stat"><b>{lowStock.length}</b><span className="tiny muted"> low stock</span></div>
        {(master.blends || []).length > 0 && (
          <>
            <span className="mo-stat-sep">·</span>
            <div className="mo-stat"><b>{(master.blends || []).length}</b><span className="tiny muted"> blends</span></div>
          </>
        )}
        {duplicates.length > 0 && (
          <>
            <span className="mo-stat-sep">·</span>
            <div className="mo-stat warn"><b>{duplicates.length}</b><span className="tiny muted"> duplicates</span></div>
          </>
        )}
        <div className="mo-actions">
          {masterLock?.locked && (
            <span className="chip warn" title={masterLock.owner ? `Held by ${masterLock.owner}` : 'Master is open in Excel'}>
              IN USE{masterLock.owner && masterLock.owner !== 'unknown' ? ` · ${masterLock.owner}` : ''}
            </span>
          )}
          <button
            className="btn btn-sm btn-edit-master"
            style={{ display: showLocalOpen ? undefined : 'none' }}
            onClick={() => setPinForEdit(true)}
            disabled={openingMaster || !!masterLock?.locked}
            title={masterLock?.locked ? 'Master is already open' : 'Open Master.xlsx in Excel. The app will go offline until you close the file.'}
          >
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M8 2 L10 4 L5 9 L2 10 L3 7 Z" stroke="currentColor" fill="none" strokeWidth="1.2"/></svg>
            {openingMaster ? 'Opening…' : 'Edit Master'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={downloadMaster} title="Download the current live workbook">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2 V8 M3 6 L6 9 L9 6 M2 10 H10" stroke="currentColor" fill="none" strokeWidth="1.4" strokeLinecap="round"/></svg>
            Download Master
          </button>
          <button
            className="btn btn-sm"
            onClick={() => { setUploadNotice(null); setUploadOpen(true); }}
            disabled={uploadingMaster || !!masterLock?.locked}
            title={masterLock?.locked ? 'Master is currently open in Excel' : 'Upload an edited workbook and replace the live Master.xlsx'}
          >
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 10 V4 M3 6 L6 3 L9 6 M2 10 H10" stroke="currentColor" fill="none" strokeWidth="1.4" strokeLinecap="round"/></svg>
            Upload Edited Master
          </button>
          {onReloadMaster && (
            <button className="btn btn-sm btn-ghost" onClick={onReloadMaster} title="Reload from disk">Refresh</button>
          )}
        </div>
      </div>
      <div className="master-edit-help">
        <div className="master-edit-help-title">
          {downloadUploadOnly ? 'Cloud workbook workflow' : 'Workbook editing workflow'}
        </div>
        <div className="master-edit-help-body">
          Download the current live Master.xlsx, edit it locally in Excel, then upload the edited copy here.
          The app creates a timestamped backup before replacing the live workbook, so routine data edits do not need to go through GitHub.
        </div>
        {showLocalOpen && !downloadUploadOnly && (
          <div className="tiny muted">
            Local host mode still supports opening the workbook directly in Excel, which temporarily takes matching offline until the file is closed.
          </div>
        )}
      </div>
      {openError && (
        <div className="master-edit-alert err">
          {openError}
        </div>
      )}
      {uploadNotice && <div className="master-edit-alert ok">{uploadNotice}</div>}
      <PinPrompt
        open={pinForEdit}
        title="Edit Master.xlsx?"
        message="This will open the workbook in Excel and take the app offline for every user until the file is closed. Enter supervisor PIN to continue."
        confirmLabel="Open in Excel"
        onCancel={() => setPinForEdit(false)}
        onConfirm={async () => { setPinForEdit(false); await doOpenMaster(); }}
      />
      {uploadOpen && (
        <div className="pin-overlay" onClick={() => !uploadingMaster && closeUploadModal()}>
          <form className="pin-dialog master-upload-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitMasterUpload}>
            <div className="pin-header">
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 7 H12 M7 2 V12" stroke="currentColor" fill="none" strokeWidth="1.2"/></svg>
              <b>Upload edited Master.xlsx</b>
            </div>
            <p className="tiny muted master-upload-copy">
              Use this for Render and any other remote deployment: download the current workbook first, edit it locally,
              then upload the revised `.xlsx` file. The current server copy is backed up automatically before replacement.
            </p>
            <label className="field master-upload-field">
              <span className="field-label">Edited workbook</span>
              <input
                ref={uploadInputRef}
                className="master-upload-input"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => {
                  const nextFile = e.target.files && e.target.files[0] ? e.target.files[0] : null;
                  setUploadFile(nextFile);
                  setUploadError(null);
                }}
              />
            </label>
            {uploadFile && <div className="master-upload-name">{uploadFile.name}</div>}
            <div className="field master-upload-field">
              <label className="field-label" htmlFor="master-upload-pin">Supervisor PIN</label>
              <input
                id="master-upload-pin"
                autoFocus
                type="password"
                inputMode="numeric"
                maxLength={4}
                className={'pin-input' + (uploadError ? ' err' : '')}
                value={uploadPin}
                onChange={(e) => {
                  setUploadPin(e.target.value.replace(/\D/g, '').slice(0, 4));
                  setUploadError(null);
                }}
                placeholder="...."
              />
            </div>
            {uploadError && <div className="pin-err">{uploadError}</div>}
            <div className="pin-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={closeUploadModal} disabled={uploadingMaster}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={uploadingMaster || uploadPin.length !== 4 || !uploadFile}>
                {uploadingMaster ? 'Uploading...' : 'Replace live workbook'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Grade table */}
      <div className="mo-section">
        <div className="mo-section-head">
          <span>Inventory by grade</span>
          <span className="tiny muted">{gradeRows.length} grade{gradeRows.length === 1 ? '' : 's'} · sorted by MT</span>
        </div>
        <table className="mo-grade-table">
          <thead>
            <tr>
              <th>Grade</th>
              <th className="num">Lots</th>
              <th className="num">MT</th>
              <th>Largest lot</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {visibleGrades.map(([g, v]) => {
              const pct = totalQty > 0 ? (v.mt / totalQty * 100) : 0;
              return (
                <tr key={g}>
                  <td><b>{g}</b></td>
                  <td className="num">{v.lots}{v.depleted > 0 && <span className="tiny muted"> ({v.depleted} dep)</span>}</td>
                  <td className="num">{fmt(v.mt, 1)}</td>
                  <td className="tiny">
                    {v.largest ? <><b>{v.largest.lot_no}</b><span className="muted">@{v.largest.col_letter}</span> <span className="muted">{fmt(v.largest.qty_mt, 1)} MT</span></> : '—'}
                  </td>
                  <td>
                    <div className="mo-share">
                      <span className="mo-share-bar"><span style={{ width: pct + '%' }}></span></span>
                      <span className="tiny muted">{pct.toFixed(0)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {gradeRows.length > 6 && (
          <button className="mo-expand-btn" onClick={() => setGradesExpanded(!gradesExpanded)}>
            {gradesExpanded ? '▴ Show top 6' : `▾ Show ${gradeRows.length - 6} more grade${gradeRows.length - 6 === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {/* Attention accordion */}
      <div className="mo-section">
        <div className="mo-section-head">
          <span>Attention</span>
          <span className="tiny muted">click to expand</span>
        </div>
        <AccordionRow label="Low stock" subtitle="≤ 2 MT" count={lowStock.length} severity={lowStock.length > 0 ? 'warn' : 'ok'}>
          <LotMiniTable rows={lowStock} dateLabel="Last edit" />
        </AccordionRow>
        <AccordionRow label="Recently edited" subtitle="lots with edit stamp" count={recentEdits.length}>
          <LotMiniTable rows={recentEdits.slice(0, 50)} dateLabel="Edited" />
          {recentEdits.length > 50 && <div className="tiny muted" style={{ padding: 8 }}>Showing 50 most recent of {recentEdits.length}.</div>}
        </AccordionRow>
        <AccordionRow label="Depleted" subtitle="qty = 0" count={depleted.length}>
          <LotMiniTable rows={depleted.slice(0, 50)} dateLabel="Last edit" />
          {depleted.length > 50 && <div className="tiny muted" style={{ padding: 8 }}>Showing 50 of {depleted.length}.</div>}
        </AccordionRow>
        {(master.blends || []).length > 0 && (
          <AccordionRow label="Blending activity" subtitle="lots formed by blending sources" count={(master.blends || []).length}>
            <div className="blend-activity-grid">
              {(master.blends || []).slice().reverse().map((b) => (
                <div key={b.blend_id} className="blend-activity-card">
                  <div className="blend-activity-head">
                    <div className="blend-activity-id">
                      <b>{b.output.lot_no}</b>
                      <span className="tiny muted">@{b.output.col_letter}</span>
                    </div>
                    <span className="chip">{b.output.grade}</span>
                    <span className="blend-activity-qty">{fmt(b.output.qty_mt, 2)} MT</span>
                  </div>
                  <div className="blend-activity-meta tiny muted">
                    from {b.sources.map((s) => `${s.lot_no} (${fmt(s.mt_used, 2)} MT)`).join(' + ')}
                  </div>
                  <div className="blend-activity-foot">
                    <span className="tiny muted">{(b.ts || '').slice(0, 10)}</span>
                    {b.card_url && (
                      <a
                        className="blend-card-link"
                        href={`${API}${b.card_url}`}
                        onClick={(e) => { e.preventDefault(); downloadBlob(`${API}${b.card_url}`, `blend-${b.blend_id}.pdf`); }}
                        title="Download blend card PDF"
                      >
                        <svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 2 V8 M3 6 L6 9 L9 6 M2 10 H10" stroke="currentColor" fill="none" strokeWidth="1.4" strokeLinecap="round"/></svg>
                        Download card
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </AccordionRow>
        )}
        {duplicates.length > 0 && (
          <AccordionRow label="Duplicate lot codes" subtitle="fix in Master.xlsx" count={duplicates.length} severity="warn">
            <div className="lot-grid">
              {duplicates.map((d) => (
                <div key={`${d.lot_no}@${d.col_letter}`} className="lot-chip">
                  <div className="lot-chip-top">
                    <b>{d.lot_no}</b>
                    <span className="tiny muted">@{d.col_letter}</span>
                    <span className="lot-chip-qty">{fmt(d.qty_mt, 1)} MT</span>
                  </div>
                  <div className="lot-chip-meta tiny muted">grade {d.grade}</div>
                </div>
              ))}
            </div>
          </AccordionRow>
        )}
      </div>

      <MasterOverviewChat user={user} />
    </div>
  );
}

function MasterOverviewChat({ user }) {
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState('english');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [configState, setConfigState] = useState({
    configured: true,
    model: '',
    languages: ['english', 'hinglish', 'tamil'],
  });
  const bodyRef = useRef(null);

  const quickPrompts = [
    'Which grade currently has the most stock?',
    'Show me all low-stock lots at or below 2 MT.',
    'Do we have any duplicate lot codes right now?',
    'Which lots were edited most recently?',
  ];
  const reportLabels = {
    english: {
      prepared: 'Report prepared',
      pdf: 'Download PDF',
      xlsx: 'Download Excel',
      reason: 'Why this was prepared',
    },
    hinglish: {
      prepared: 'Report ready',
      pdf: 'PDF download karo',
      xlsx: 'Excel download karo',
      reason: 'Yeh report kyun bani',
    },
    tamil: {
      prepared: 'அறிக்கை தயார்',
      pdf: 'PDF பதிவிறக்கு',
      xlsx: 'Excel பதிவிறக்கு',
      reason: 'இந்த அறிக்கை ஏன் தயார் செய்யப்பட்டது',
    },
  };

  useEffect(() => {
    if (!open) return;
    api('/master/chat/config')
      .then((data) => {
        setConfigState({
          configured: data?.configured !== false,
          model: data?.model || '',
          languages: data?.languages || ['english', 'hinglish', 'tamil'],
        });
      })
      .catch((err) => setError(String(err)));
  }, [open]);

  useEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, sending, open]);

  const submitQuestion = useCallback(async (questionText) => {
    const text = (questionText ?? draft).trim();
    if (!text || sending) return;

    const nextMessages = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);
    setDraft('');
    setError('');
    setSending(true);

    try {
      const response = await fetchWithRenderWake(`${API}/api/v3/master/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: text,
          language,
          history: messages,
          user_name: user?.name || user?.username || '',
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || `${response.status} ${response.statusText}`);
      }
      setMessages([
        ...nextMessages,
        {
          role: 'assistant',
          content: data?.answer || 'I could not find an answer in the current master overview data.',
          report: data?.report || null,
        },
      ]);
    } catch (err) {
      setMessages(nextMessages);
      setError(String(err));
    } finally {
      setSending(false);
    }
  }, [draft, language, messages, sending, user]);

  function onComposerKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitQuestion();
    }
  }

  async function downloadReportFile(fileInfo, fallbackLabel) {
    const url = `${API}${fileInfo?.url || ''}`;
    if (!fileInfo?.url) return;
    setError('');
    try {
      const response = await fetchWithRenderWake(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const blob = await response.blob();
      const contentDisposition = response.headers.get('Content-Disposition') || '';
      const match = contentDisposition.match(/filename="?([^"]+)"?/i);
      const filename = match?.[1] || fileInfo?.filename || fallbackLabel || 'report';
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError(`Download failed: ${String(err)}`);
    }
  }

  return (
    <>
      <button
        className={'anirudh-fab' + (open ? ' open' : '')}
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-label="ask anirudh"
      >
        <span className="anirudh-fab-text" aria-hidden="true">
          <span className="anirudh-fab-typed">Ask Anirudh</span>
          <span className="anirudh-fab-caret">|</span>
        </span>
        <span className="anirudh-fab-orb" aria-hidden="true">
          <span className="anirudh-fab-ring" aria-hidden="true"></span>
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="8.5" r="3.6" />
            <path d="M5 20.5c0-3.7 3.2-6.2 7-6.2s7 2.5 7 6.2" />
          </svg>
          <span className="anirudh-fab-pulse" aria-hidden="true"></span>
        </span>
      </button>

      {open && (
        <div className="anirudh-panel" role="dialog" aria-label="Ask Anirudh">
          <div className="anirudh-panel-head">
            <div>
              <div className="anirudh-panel-title">Ask Anirudh</div>
              <div className="anirudh-panel-sub">Grounded in inventory truth.</div>
            </div>
            <div className="anirudh-panel-controls">
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="anirudh-language">
                {(configState.languages || ['english', 'hinglish', 'tamil']).map((option) => (
                  <option key={option} value={option}>
                    {option === 'english' ? 'English' : option === 'hinglish' ? 'Hinglish' : 'Tamil'}
                  </option>
                ))}
              </select>
              <button type="button" className="anirudh-close" onClick={() => setOpen(false)} aria-label="Close chat">x</button>
            </div>
          </div>

          {!configState.configured && (
            <div className="anirudh-banner warn">
              Chat is not configured yet. Set MASTER_OVERVIEW_OPENAI_API_KEY or OPENAI_API_KEY on the backend.
            </div>
          )}

          <div className="anirudh-body" ref={bodyRef}>
            {messages.length === 0 && (
              <div className="anirudh-empty">
                <div className="anirudh-empty-title">Ask about grades, lots, low stock, duplicates, or edit history.</div>
                <div className="anirudh-empty-copy">If something is not present in master overview data, Anirudh will say so instead of guessing.</div>
                <div className="anirudh-quick-grid">
                  {quickPrompts.map((prompt) => (
                    <button key={prompt} type="button" className="anirudh-quick" onClick={() => submitQuestion(prompt)}>
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={'anirudh-msg ' + message.role}>
                <div className="anirudh-msg-role">{message.role === 'assistant' ? 'Anirudh' : 'You'}</div>
                <div className="anirudh-msg-bubble">
                  <div>{renderChatContent(message.content)}</div>
                  {message.report && (
                    <div className="anirudh-report-card">
                      <div className="anirudh-report-head">
                        <span>{(reportLabels[language] || reportLabels.english).prepared}</span>
                        <b>{message.report.title}</b>
                      </div>
                      <div className="anirudh-report-copy">{message.report.summary}</div>
                      {message.report.reason && (
                        <div className="anirudh-report-reason">
                          <span>{(reportLabels[language] || reportLabels.english).reason}:</span> {message.report.reason}
                        </div>
                      )}
                      <div className="anirudh-report-actions">
                        <button
                          type="button"
                          className="anirudh-report-link"
                          onClick={() => downloadReportFile(message.report.files?.pdf, 'report.pdf')}
                        >
                          {(reportLabels[language] || reportLabels.english).pdf}
                        </button>
                        <button
                          type="button"
                          className="anirudh-report-link secondary"
                          onClick={() => downloadReportFile(message.report.files?.xlsx, 'report.xlsx')}
                        >
                          {(reportLabels[language] || reportLabels.english).xlsx}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {sending && (
              <div className="anirudh-msg assistant">
                <div className="anirudh-msg-role">Anirudh</div>
                <div className="anirudh-msg-bubble typing">
                  <span></span><span></span><span></span>
                </div>
              </div>
            )}
          </div>

          {error && <div className="anirudh-banner">{error}</div>}

          <div className="anirudh-composer">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Ask about the master overview..."
              rows={3}
              disabled={sending || !configState.configured}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => submitQuestion()}
              disabled={sending || !draft.trim() || !configState.configured}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function AccordionRow({ label, subtitle, count, severity, children }) {
  const [open, setOpen] = useState(false);
  const chipCls = severity === 'warn' ? 'chip warn' : severity === 'ok' && count === 0 ? 'chip ok' : 'chip';
  return (
    <div className={'mo-acc' + (open ? ' open' : '')}>
      <button className="mo-acc-head" onClick={() => setOpen(!open)}>
        <span className="mo-acc-caret">{open ? '▾' : '▸'}</span>
        <span className="mo-acc-label">{label}</span>
        <span className="tiny muted">{subtitle}</span>
        <span className={chipCls} style={{ marginLeft: 'auto' }}>{count}</span>
      </button>
      {open && <div className="mo-acc-body">{children}</div>}
    </div>
  );
}

function LotMiniTable({ rows, dateLabel }) {
  if (rows.length === 0) return <div className="tiny muted" style={{ padding: 10, fontStyle: 'italic' }}>None.</div>;
  return (
    <div className="lot-grid">
      {rows.map((l) => {
        const notes = l.blend_notes || [];
        const totalBlended = notes.reduce((s, n) => s + (n.mt_used || 0), 0);
        return (
          <div key={l.lot_id} className="lot-chip">
            <div className="lot-chip-top">
              <b>{l.lot_no}</b>
              <span className="tiny muted">@{l.col_letter}</span>
              <span className={'lot-chip-qty ' + ((l.qty_mt || 0) <= 0.5 ? 'delta-bad' : '')}>{fmt(l.qty_mt, 2)} MT</span>
              {l.is_blended && <span className="chip blend-tag">blended</span>}
              {totalBlended > 0 && <span className="chip blend-tag-src" title={notes.map((n) => n.note).join('\n')}>{fmt(totalBlended, 2)} MT → blend</span>}
            </div>
            <div className="lot-chip-meta tiny muted">
              grade {l.grade || '—'} · {dateLabel.toLowerCase()} {l.last_edited || '—'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============== RECENT FULFILLMENTS ==============
function RecentFulfillments({ onEditFulfillment }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pinFor, setPinFor] = useState(null); // fulfillment awaiting PIN
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState(false);
  const [showAll, setShowAll] = useState(false);

  function requestEdit(f) { setPin(''); setPinErr(false); setPinFor(f); }
  async function submitPin(e) {
    e?.preventDefault();
    if (pin.length !== 4) return;
    try {
      await onEditFulfillment(pinFor, pin);
      setPinFor(null);
    } catch (err) {
      setPinErr(true);
    }
  }

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api('/fulfillments');
      setRows(d.fulfillments || []);
    } catch (e) { /* surface elsewhere */ }
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const editable = rows.filter((r) => r.editable);
  const history = rows.filter((r) => !r.editable);
  const historyVisible = showAll ? history : history.slice(0, 5);

  return (
    <div className="home-panel" style={{ marginTop: 16 }}>
      <div className="home-panel-head">
        <span>Recently fulfilled requirements</span>
        <span className="count">
          {editable.length} editable · {history.length} historical
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={reload}>↻</button>
        </span>
      </div>

      {loading && <div className="tiny muted" style={{ padding: 12 }}>Loading…</div>}
      {!loading && rows.length === 0 && (
        <div className="tiny muted" style={{ padding: 12, fontStyle: 'italic' }}>No fulfillments recorded yet.</div>
      )}

      {editable.length > 0 && (
        <div style={{ padding: '6px 12px' }}>
          <div className="tiny muted" style={{ marginBottom: 4 }}>WITHIN 24H · EDITABLE</div>
          <FulfillmentTable rows={editable} editable onEdit={requestEdit} />
        </div>
      )}

      {history.length > 0 && (
        <div style={{ padding: '6px 12px', borderTop: '1px solid var(--line-2)' }}>
          <div className="tiny muted" style={{ marginBottom: 4 }}>HISTORY · READ-ONLY</div>
          <FulfillmentTable rows={historyVisible} />
          {history.length > 5 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? `Show fewer` : `Show all ${history.length}`}
            </button>
          )}
        </div>
      )}

      {pinFor && (
        <div className="pin-overlay" onClick={() => setPinFor(null)}>
          <form className="pin-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPin}>
            <div className="pin-header">
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7 V5 a4 4 0 0 1 8 0 V7 M3 7 H11 V13 H3 Z" stroke="currentColor" fill="none" strokeWidth="1.2"/></svg>
              <b>Supervisor PIN required</b>
            </div>
            <p className="tiny muted" style={{ margin: '6px 0 10px' }}>
              Enter the 4-digit override PIN.
            </p>
            <input autoFocus type="password" inputMode="numeric" maxLength={4}
              className={'pin-input' + (pinErr ? ' err' : '')}
              value={pin}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setPinErr(false); }}
              placeholder="• • • •" />
            {pinErr && <div className="pin-err">Incorrect PIN. Try again.</div>}
            <div className="pin-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPinFor(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={pin.length !== 4}>Unlock</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function FulfillmentTable({ rows, editable, onEdit }) {
  return (
    <div className="fulfill-table-wrap">
    <table className="lots fulfill-table" style={{ marginTop: 4 }}>
      <colgroup>
        <col className="col-when" />
        <col className="col-cust" />
        <col className="col-by" />
        <col className="col-req" />
        <col className="col-lots" />
        <col className="col-tot" />
        <col className="col-act" />
      </colgroup>
      <thead>
        <tr>
          <th>When</th>
          <th>Customer</th>
          <th>By</th>
          <th className="num">Req · MT</th>
          <th className="num">Lots</th>
          <th className="num">Total · MT</th>
          <th aria-hidden="true"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const total = (r.lines || []).reduce((s, l) => s + (l.consume_mt || 0), 0);
          return (
            <tr key={r.id}>
              <td className="num tiny">{(r.ts || '').replace('T', ' ')}</td>
              <td className="lot-cell">
                <span className="fulfill-cust-name">{r.customer_name || r.customer_id}</span>
                {r.edited_at && <span className="chip fulfill-cust-edited">edited</span>}
              </td>
              <td className="tiny muted">{r.user}</td>
              <td className="num">{fmt(r.qty_requested, 1)}</td>
              <td className="num">{(r.lines || []).length}</td>
              <td className="num">{fmt(total, 2)}</td>
              <td className="act-cell">
                {editable && (
                  <button className="btn btn-sm" onClick={() => onEdit(r)}>Edit</button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

// ============== EDIT MODAL ==============
function NewLotForm({ onAdd, onCancel }) {
  const [f, setF] = useState({
    lot_no: '', grade: '', qty_mt: '',
    mt_DL: '', mt_Da: '', mt_Db: '', mt_DE: '',
    rt_DL: '', rt_Da: '', rt_Db: '', rt_DE: '', strength: '',
    qty_consume: '',
  });
  const [errs, setErrs] = useState({});
  function set(k, v) {
    setF((x) => ({ ...x, [k]: v }));
    if (errs[k]) setErrs((e) => { const n = { ...e }; delete n[k]; return n; });
  }
  // Every field is required: new lots bypass ranking, so we cannot
  // tolerate missing color/strength values that the rest of the app assumes.
  const REQUIRED = [
    ['lot_no', 'Lot No', 'text'],
    ['grade', 'Grade', 'text'],
    ['qty_mt', 'Stock MT', 'num-pos'],
    ['qty_consume', 'Consume MT', 'num-pos'],
    ['mt_DL', 'MT ΔL', 'num'], ['mt_Da', 'MT Δa', 'num'], ['mt_Db', 'MT Δb', 'num'], ['mt_DE', 'MT ΔE', 'num'],
    ['rt_DL', 'RT ΔL', 'num'], ['rt_Da', 'RT Δa', 'num'], ['rt_Db', 'RT Δb', 'num'], ['rt_DE', 'RT ΔE', 'num'],
    ['strength', 'Strength', 'num-pos'],
  ];
  function submit() {
    const missing = {};
    for (const [k, label, kind] of REQUIRED) {
      const v = String(f[k] ?? '').trim();
      if (v === '') { missing[k] = `${label} required`; continue; }
      if (kind === 'num' || kind === 'num-pos') {
        const n = Number(v);
        if (!Number.isFinite(n)) { missing[k] = `${label} must be a number`; continue; }
        if (kind === 'num-pos' && n < 0) { missing[k] = `${label} must be ≥ 0`; continue; }
      }
    }
    if (Object.keys(missing).length) { setErrs(missing); return; }
    if (Number(f.qty_consume) > Number(f.qty_mt)) {
      setErrs({ qty_consume: 'Consume cannot exceed stock' }); return;
    }
    setErrs({});
    onAdd({
      lot_no: f.lot_no.trim(),
      grade: f.grade.trim(),
      qty_mt: Number(f.qty_mt),
      qty_consume: Number(f.qty_consume),
      mass_tone: { DL: Number(f.mt_DL), Da: Number(f.mt_Da), Db: Number(f.mt_Db), DE: Number(f.mt_DE) },
      tint_tone: { DL: Number(f.rt_DL), Da: Number(f.rt_Da), Db: Number(f.rt_Db), DE: Number(f.rt_DE), Strength: Number(f.strength) },
    });
  }
  const F = (k, label, props = {}) => (
    <label className={'edit-field' + (errs[k] ? ' has-err' : '')}>
      <span className="k">{label}</span>
      <input value={f[k]} onChange={(e) => set(k, e.target.value)} {...props} />
    </label>
  );
  const errList = Object.values(errs);
  return (
    <div style={{ background: 'var(--bg-stripe)', padding: 10, borderRadius: 4, marginTop: 8, border: '1px solid var(--line)' }}>
      <div className="tiny muted" style={{ marginBottom: 6 }}>NEW LOT · Method I a (MT) + I b (RT) required</div>
      <div className="edit-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {F('lot_no', 'Lot No')}
        {F('grade', 'Grade')}
        {F('qty_mt', 'Stock MT', { type: 'number', step: '0.01', min: 0 })}
        {F('qty_consume', 'Consume MT', { type: 'number', step: '0.01', min: 0 })}
        <div style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>Mass Tone (Method I a)</div>
        {F('mt_DL', 'MT ΔL', { type: 'number', step: '0.01' })}
        {F('mt_Da', 'MT Δa', { type: 'number', step: '0.01' })}
        {F('mt_Db', 'MT Δb', { type: 'number', step: '0.01' })}
        {F('mt_DE', 'MT ΔE', { type: 'number', step: '0.01' })}
        <div style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>Tint Tone (Method I b)</div>
        {F('rt_DL', 'RT ΔL', { type: 'number', step: '0.01' })}
        {F('rt_Da', 'RT Δa', { type: 'number', step: '0.01' })}
        {F('rt_Db', 'RT Δb', { type: 'number', step: '0.01' })}
        {F('rt_DE', 'RT ΔE', { type: 'number', step: '0.01' })}
        {F('strength', 'Strength', { type: 'number', step: '0.01' })}
      </div>
      {errList.length > 0 && (
        <div style={{ marginTop: 8, padding: '6px 10px', background: 'var(--warn-soft)', color: 'var(--err)', borderRadius: 3, fontSize: 11.5, lineHeight: 1.5 }}>
          {errList.map((m, i) => <div key={i}>· {m}</div>)}
        </div>
      )}
      <div className="pin-actions" style={{ marginTop: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={submit}>Add lot to fulfillment</button>
      </div>
    </div>
  );
}

// ============== RESULTS ==============
function ResultsScreen({ customer, qty, ranked, allocated, onToggleAllocate, onSetAllocateQty, onAllocateFullLot, onRemoveAllocate, onAutoFulfill, onClear, onCommit, onSaveOverride, onRevertOverride, onBack, topN, showOnlyWithin, showOnlyDirection, onTopN, onShowOnlyWithin, onShowOnlyDirection, committing, editingFulfillment, newLots, onAddNewLot, onRemoveNewLot, methods, requiredTests, onTests, onCancelFulfillment, masterLock }) {
  const isEdit = !!editingFulfillment;
  const [showNewLotForm, setShowNewLotForm] = useState(false);
  const [showOriginalReport, setShowOriginalReport] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [expandedRow, setExpandedRow] = useState(null);

  // Synthetic ranked entries for manually-added new lots (edit mode only).
  // New lots bypass the ranking pipeline — they are operator-trusted overrides
  // and need to appear in the allocated zone + master sheet post-commit.
  const newLotRows = (newLots || []).map((nl) => ({
    lot_id: `${nl.lot_no}@__new__`,
    lot_no: nl.lot_no,
    col_letter: '__new__',
    grade: nl.grade,
    qty_mt: Number(nl.qty_mt || 0),
    last_edited: null,
    mass_tone: nl.mass_tone || {},
    tint_tone: nl.tint_tone || {},
    all_blocks: {},
    present_methods: [],
    scores: {},
    ranks: { euclid: '—', cosine: '—', knn: '—', age: '—', consensus: 0 },
    within: { all: true, mt: {}, rt: {}, strength: true, reasons: [] },
    direction: { all: true, mt: {}, rt: {}, reasons: [] },
    _isNewLot: true,
  }));
  const rankedAll = newLotRows.length ? [...newLotRows, ...ranked] : ranked;
  const allocatedList = rankedAll.filter((l) => allocated.has(l.lot_id)).map((l) => ({ ...l, _alloc: allocated.get(l.lot_id) }));
  const allocatedQty = allocatedList.reduce((s, l) => s + l._alloc, 0);
  const shortfall = Math.max(0, qty - allocatedQty);
  const directionFiltered = showOnlyDirection
    ? ranked.filter((l) => (l.direction?.all ?? true))
    : ranked;
  const visible = directionFiltered.slice(0, topN);
  const availableLots = visible.filter((l) => !allocated.has(l.lot_id));
  const maxScore = Math.max(...ranked.slice(0, topN).map((l) => l.ranks.consensus), 1);

  return (
    <div className="results">
      <aside className="results-side">
        <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ alignSelf: 'flex-start' }}>
          {editingFulfillment ? (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" fill="none" strokeWidth="1.4"/></svg>
              Finish editing
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M9 6 H3 M6 3 L3 6 L6 9" stroke="currentColor" fill="none" strokeWidth="1.4"/></svg>
              New request
            </>
          )}
        </button>

        <div className="cust-card">
          <div className="cust-id-strip">
            <span className="chip accent">{customer.id}</span>
            <span>· grade {customer.grade}</span>
          </div>
          <h2 className="cust-name">{customer.name}</h2>
          <div className="cust-meta">
            <span>Latest COA</span>
            <div className="num tiny muted">{customer.latest_pdf}</div>
            <div className="num tiny muted">Report · {customer.report_date}</div>
            <div className="num tiny muted">STD · {customer.std}</div>
          </div>
        </div>

        <div className="side-section-h"><span>COA Targets</span></div>
        <CoaTargetCard customer={customer} onSaveOverride={onSaveOverride} onRevertOverride={onRevertOverride} locked={!!editingFulfillment} />

        {!editingFulfillment && (
          <>
            <div className="side-section-h"><span>Required Tests</span></div>
            <div className="side-tests-card">
              <RequiredTestsField methods={methods} requiredTests={requiredTests} onTests={onTests} compact />
              <div className="tiny muted" style={{ marginTop: 4 }}>Toggle to re-rank · lots missing any checked test excluded.</div>
            </div>
          </>
        )}

      </aside>

      <section className="results-main">
        <div className="results-table-col">
          <div className="subtoolbar sticky-toolbar">
            <div className="crumbs">
              <span>{isEdit ? 'Recent fulfillments' : 'Intake'}</span><span>›</span>
              <span style={{ color: 'var(--ink)' }}>{isEdit ? `Edit · ${editingFulfillment.ts}` : 'Match Results'}</span>
            </div>
            <h2 style={{ marginLeft: 12 }}>{isEdit ? 'Edit fulfillment' : 'Ranked candidates'}</h2>
            <div className="right">
              {!isEdit && <button className="btn btn-sm btn-auto" onClick={onAutoFulfill} disabled={qty <= 0} title="Greedy: full lots in rank order, partial cut on last">Auto-fulfill</button>}
              <button className="btn btn-sm" onClick={onClear} disabled={allocatedList.length === 0}>Clear</button>
              {isEdit && <button className="btn btn-sm" onClick={() => setShowNewLotForm(true)}>+ New lot</button>}
              <div className="toolbar-view">
                <label className="toolbar-view-item">
                  <input type="checkbox" checked={showOnlyWithin} onChange={(e) => onShowOnlyWithin(e.target.checked)} />
                  <span>In-spec</span>
                </label>
                <label className="toolbar-view-item">
                  <input type="checkbox" checked={showOnlyDirection} onChange={(e) => onShowOnlyDirection(e.target.checked)} />
                  <span>Direction</span>
                </label>
                <label className="toolbar-view-item">
                  <span>Show lots</span>
                  <input type="number" min={1} value={topN}
                         onChange={(e) => {
                           const raw = e.target.value;
                           if (raw === '') { onTopN(''); return; }
                           const n = Number(raw);
                           if (!Number.isFinite(n)) return;
                           onTopN(n);
                         }}
                         onBlur={(e) => {
                           const n = Number(e.target.value);
                           const max = Math.max(1, directionFiltered.length);
                           const clamped = !Number.isFinite(n) || n < 1 ? 12 : Math.min(max, Math.max(1, Math.floor(n)));
                           onTopN(clamped);
                         }} />
                  <span className="tiny muted">of {directionFiltered.length}</span>
                </label>
              </div>
            </div>
          </div>
          {isEdit && (
            <div className="banner warn edit-banner" style={{ margin: '10px 18px 0' }}>
              <b>Editing fulfillment</b>
              <span className="sep">·</span>
              <span>{editingFulfillment.customer_name || editingFulfillment.customer_id}</span>
              <span className="sep">·</span>
              <span className="tiny muted">{editingFulfillment.ts}</span>
              <span className="sep">·</span>
              <span>{(editingFulfillment.lines || []).length} lot{(editingFulfillment.lines || []).length === 1 ? '' : 's'} originally</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button className="btn btn-sm" onClick={() => setShowOriginalReport(true)}>
                  View original report
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => setConfirmCancel(true)}
                  disabled={committing || !!masterLock?.locked}
                  title={masterLock?.locked ? 'Master.xlsx is being edited' : ''}
                >
                  Cancel fulfillment
                </button>
              </div>
            </div>
          )}
          {isEdit && showOriginalReport && (
            <OriginalReportModal fulfillment={editingFulfillment} onClose={() => setShowOriginalReport(false)} />
          )}
          {isEdit && (
            <PinPrompt
              open={confirmCancel}
              title="Cancel this fulfillment?"
              message={`All ${(editingFulfillment.lines || []).length} line${(editingFulfillment.lines || []).length === 1 ? '' : 's'} will be returned to master and the record will be removed. This cannot be undone. Enter supervisor PIN to confirm.`}
              confirmLabel="Yes, cancel"
              danger
              onCancel={() => setConfirmCancel(false)}
              onConfirm={async () => { setConfirmCancel(false); await onCancelFulfillment(); }}
            />
          )}
          {isEdit && showNewLotForm && (
            <div style={{ margin: '8px 18px 0' }}>
              <NewLotForm onAdd={(spec) => { onAddNewLot(spec); setShowNewLotForm(false); }} onCancel={() => setShowNewLotForm(false)} />
            </div>
          )}

          <div className="table-wrap">
            <table className="lots lots-compact">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>#</th>
                  <th>Lot</th>
                  <th className="num">Stock</th>
                  <th>Match</th>
                  <th style={{ width: 64, textAlign: 'center' }}>
                    <span className="th-with-info">
                      Spec
                      <span className="info-dot" tabIndex={0} data-tip={
`Within COA tolerance band on every axis (MT + RT ΔL/Δa/Δb/ΔE + strength). Out-of-spec lots rank after all in-spec lots; auto-fulfill skips them.

✓  Limit Da ±0.95, lot Da −0.42
✕  Limit Da ±0.95, lot Da −1.36`
                      }>i</span>
                    </span>
                  </th>
                  <th style={{ width: 64, textAlign: 'center' }}>
                    <span className="th-with-info">
                      Dir
                      <span className="info-dot" tabIndex={0} data-tip={
`Sign of lot delta matches sign of COA delta on each axis — captures which side of standard the shade leans (lighter/darker etc.). Axes with |COA| < 0.05 skipped. Wrong-direction lots drop a tier; auto-fulfill skips them.

✓  COA Da −0.40, lot Da −0.20
✕  COA Da −0.40, lot Da +0.30`
                      }>i</span>
                    </span>
                  </th>
                  <th className="num">Strength</th>
                  <th style={{ width: 170 }}>Allocate · MT</th>
                </tr>
              </thead>
              <tbody>
                {allocatedList.length > 0 && (
                  <tr className="zone-row zone-row-alloc">
                    <td colSpan="8">
                      ALLOCATED · {allocatedList.length} lot{allocatedList.length === 1 ? '' : 's'} · {fmt(allocatedQty, 2)} MT
                    </td>
                  </tr>
                )}
                {allocatedList.map((lot, idx) => {
                  const w = lot.within || { mt: {}, rt: {}, all: true };
                  const d = lot.direction || { mt: {}, rt: {}, all: true, reasons: [] };
                  const allocAmt = lot._alloc;
                  const isExpanded = expandedRow === lot.lot_id;
                  const ranks = lot.ranks || { consensus: '—', euclid: '—', cosine: '—', knn: '—' };
                  const matchPct = ranks.consensus === '—' ? 0 : Math.max(8, Math.min(100, 100 * (1 - (ranks.consensus - 3) / Math.max(1, maxScore))));
                  const strengthIn = w.strength !== false;
                  const effectiveStock = lot._original ? (Number(lot.qty_mt) + Number(lot._origConsume || 0)) : Number(lot.qty_mt);
                  const after = +(effectiveStock - allocAmt).toFixed(3);
                  const fullTake = allocAmt >= effectiveStock - 1e-3;
                  return (
                    <React.Fragment key={`picked-${lot.lot_id}`}>
                      <tr className="row-allocated">
                        <td className="num tiny" style={{ color: 'var(--ok)' }}>✓</td>
                        <td className="lot-cell">
                          <button onClick={() => setExpandedRow(isExpanded ? null : lot.lot_id)}
                                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', padding: 0, marginRight: 4, fontSize: 10 }}>
                            {isExpanded ? '▾' : '▸'}
                          </button>
                          <b>{lot.lot_no}</b>
                          <span className="tiny muted" style={{ marginLeft: 4 }}>@{lot.col_letter}</span>
                          {lot.is_super && <span className="chip super-chip" title={`Tested on ${(lot.present_methods || []).length} methods — auto-fulfill avoids these unless required`}>super</span>}
                          {lot._original && <span className="chip" style={{ marginLeft: 6, fontSize: 9.5 }}>original</span>}
                          <span className="tiny muted" style={{ marginLeft: 8 }}>{fmt(effectiveStock, 1)} → {fmt(after, 1)} {fullTake && '· depleted'}</span>
                        </td>
                        <td className="num">{fmt(effectiveStock, 1)}</td>
                        <td>
                          <div className="match-cell" title={`Overall #${ranks.consensus} · Euclid #${ranks.euclid} · Cosine ${ranks.cosine != null ? '#'+ranks.cosine : 'skipped'} · KNN #${ranks.knn}`}>
                            <span className="match-bar"><span style={{ width: matchPct + '%' }}></span></span>
                            <span className="tiny muted" style={{ marginLeft: 6 }}>#{ranks.consensus}</span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={'flag-mark ' + (w.all ? 'ok' : 'bad')}
                                title={w.all ? 'in spec' : ((w.reasons || []).join(' • ') || 'out of spec')}>
                            {w.all ? '✓' : '✕'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={'flag-mark ' + (d.all ? 'ok' : 'bad')}
                                title={d.all ? 'direction matches COA' : ((d.reasons || []).join(' • ') || 'wrong direction')}>
                            {d.all ? '✓' : '✕'}
                          </span>
                        </td>
                        <td className={'num ' + (strengthIn ? '' : 'delta-bad')}>{fmt(lot.tint_tone?.Strength, 1)}</td>
                        <td>
                          <AllocCell lot={lot} allocAmt={allocAmt} onSetAllocateQty={onSetAllocateQty}
                                     onAllocateFullLot={onAllocateFullLot} onRemoveAllocate={onRemoveAllocate}
                                     remainingMt={Math.max(0, qty - allocatedQty + allocAmt)}
                                     effectiveStock={effectiveStock}
                                     canRemove />
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="lot-detail">
                          <td></td>
                          <td colSpan="7">
                            <LotDetail lot={lot} w={w} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {allocatedList.length > 0 && availableLots.length > 0 && (
                  <tr className="zone-row">
                    <td colSpan="8">RANKED · {availableLots.length} candidate{availableLots.length === 1 ? '' : 's'}</td>
                  </tr>
                )}
                {availableLots.map((lot, idx) => {
                  const selected = allocated.has(lot.lot_id);
                  const w = lot.within;
                  const d = lot.direction || { mt: {}, rt: {}, all: true, reasons: [] };
                  const allocAmt = allocated.get(lot.lot_id) || 0;
                  const isExpanded = expandedRow === lot.lot_id;
                  const matchPct = Math.max(8, Math.min(100, 100 * (1 - (lot.ranks.consensus - 3) / Math.max(1, maxScore))));
                  const strengthIn = w.strength !== false;
                  return (
                    <React.Fragment key={lot.lot_id}>
                      <tr className={selected ? 'selected' : ''}>
                        <td className="num tiny" style={{ color: 'var(--ink-3)' }}>{idx + 1}</td>
                        <td className="lot-cell">
                          <button onClick={() => setExpandedRow(isExpanded ? null : lot.lot_id)}
                                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', padding: 0, marginRight: 4, fontSize: 10 }}
                                  title={isExpanded ? 'Hide details' : 'Show deltas + rank breakdown'}>
                            {isExpanded ? '▾' : '▸'}
                          </button>
                          <b>{lot.lot_no}</b>
                          <span className="tiny muted" style={{ marginLeft: 4 }}>@{lot.col_letter}</span>
                          {lot.is_super && <span className="chip super-chip" title={`Tested on ${(lot.present_methods || []).length} methods — auto-fulfill avoids these unless required`}>super</span>}
                          {lot._original && <span className="chip" style={{ marginLeft: 6, fontSize: 9.5 }}>original</span>}
                          {lot.last_edited && <span className="tiny muted" style={{ marginLeft: 6 }}>edt {lot.last_edited}</span>}
                        </td>
                        <td className="num">{fmt(lot.qty_mt, 1)}</td>
                        <td>
                          <div className="match-cell" title={`Overall #${lot.ranks.consensus} · Euclid #${lot.ranks.euclid} · Cosine ${lot.ranks.cosine != null ? '#'+lot.ranks.cosine : 'skipped'} · KNN #${lot.ranks.knn}`}>
                            <span className="match-bar"><span style={{ width: matchPct + '%' }}></span></span>
                            <span className="tiny muted" style={{ marginLeft: 6 }}>#{lot.ranks.consensus}</span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={'flag-mark ' + (w.all ? 'ok' : 'bad')}
                                title={w.all ? 'in spec' : ((w.reasons || []).join(' • ') || 'out of spec')}>
                            {w.all ? '✓' : '✕'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={'flag-mark ' + (d.all ? 'ok' : 'bad')}
                                title={d.all ? 'direction matches COA' : ((d.reasons || []).join(' • ') || 'wrong direction')}>
                            {d.all ? '✓' : '✕'}
                          </span>
                        </td>
                        <td className={'num ' + (strengthIn ? '' : 'delta-bad')}>{fmt(lot.tint_tone.Strength, 1)}</td>
                        <td>
                          <AllocCell lot={lot} allocAmt={selected ? allocAmt : ''}
                                     onSetAllocateQty={onSetAllocateQty}
                                     onAllocateFullLot={onAllocateFullLot}
                                     onRemoveAllocate={onRemoveAllocate}
                                     remainingMt={Math.max(0, qty - allocatedQty)}
                                     canRemove={selected} />
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="lot-detail">
                          <td></td>
                          <td colSpan="7"><LotDetail lot={lot} w={w} /></td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {visible.length === 0 && (
                  <tr><td colSpan="8" style={{ textAlign: 'center', padding: 24, color: 'var(--ink-3)', fontStyle: 'italic' }}>
                    No candidates. Adjust filters or grade-strict.
                  </td></tr>
                )}
              </tbody>
            </table>
            <div className="tiny muted" style={{ padding: '6px 18px' }}>
              Showing {visible.length} of {ranked.length}. Click ▸ for ΔL/Δa/Δb + per-method ranks.
            </div>
          </div>
        </div>

        <div className="results-footer">
          <div className="sticky-footer-text">
            <span className="tiny muted">TOTAL</span>
            <b className="num">{fmt(allocatedQty, 2)} MT</b>
            <span className="tiny muted">/ {fmt(qty, 2)} MT requested · {allocatedList.length} lot{allocatedList.length === 1 ? '' : 's'}</span>
            {shortfall === 0 && allocatedQty > 0 && <span className="chip ok">ready</span>}
            {shortfall > 0 && <span className="chip warn">{fmt(shortfall, 2)} MT short</span>}
            {allocatedQty > qty + 1e-3 && <span className="chip err">over by {fmt(allocatedQty - qty, 2)} MT</span>}
            <TestingTag compact />
          </div>
          <button className="btn btn-primary"
                  onClick={onCommit}
                  title={masterLock?.locked ? 'Master.xlsx is being edited — commit disabled' : ''}
                  disabled={committing || allocatedList.length === 0 || allocatedQty > qty + 1e-3 || !!masterLock?.locked}>
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6 L5 9 L10 3" stroke="currentColor" fill="none" strokeWidth="1.6"/></svg>
            {committing ? 'Committing…' : masterLock?.locked ? 'Offline · master in use' : (isEdit ? `Save · ${fmt(allocatedQty, 1)} MT` : `Commit · ${fmt(allocatedQty, 1)} MT`)}
          </button>
        </div>
      </section>
    </div>
  );
}

function AllocCell({ lot, allocAmt, onSetAllocateQty, onAllocateFullLot, onRemoveAllocate, canRemove, remainingMt, effectiveStock }) {
  const stock = effectiveStock != null ? Number(effectiveStock) : Number(lot.qty_mt);
  // Three modes:
  //   1) not allocated: stage qty in local state, click "add" to commit
  //   2) allocated, display-only: show qty + Edit / × buttons
  //   3) allocated, editing: input + Save / Cancel — Save writes to parent, Cancel reverts
  const isAllocated = canRemove;
  const [mode, setMode] = React.useState(isAllocated ? 'view' : 'stage');
  const [text, setText] = React.useState(isAllocated ? String(allocAmt) : '');

  // Sync when allocAmt changes externally (e.g. cleared from outside)
  React.useEffect(() => {
    if (!isAllocated) {
      setMode('stage');
      setText('');
    } else if (mode === 'view') {
      setText(String(allocAmt));
    }
  }, [allocAmt, isAllocated]); // eslint-disable-line

  const numeric = Number(text);
  const hasInput = text !== '' && isFinite(numeric) && numeric > 0;
  const overStock = hasInput && numeric > stock + 1e-6;
  // For stage: remainingMt is room left in order excluding this lot
  // For edit: remainingMt was computed including this lot's current alloc, so it's the max we can swap to
  const overRemaining = hasInput && remainingMt != null && numeric > remainingMt + 1e-6;
  const blocked = overStock || overRemaining;

  const doAdd = () => {
    if (!hasInput || blocked) return;
    onSetAllocateQty(lot.lot_id, text);
  };
  const doSave = () => {
    if (!hasInput || blocked) return;
    onSetAllocateQty(lot.lot_id, text);
    setMode('view');
  };
  const doCancel = () => {
    setText(String(allocAmt));
    setMode('view');
  };
  const doEdit = () => {
    setText(String(allocAmt));
    setMode('edit');
  };
  const doFull = () => {
    const cap = remainingMt != null ? Math.min(stock, remainingMt) : stock;
    if (cap <= 0) return;
    const v = +cap.toFixed(3);
    setText(String(v));
    if (mode === 'stage') onSetAllocateQty(lot.lot_id, v);
    if (mode === 'edit') {/* user must press Save */}
  };

  // VIEW mode: display-only allocated qty
  if (mode === 'view') {
    return (
      <div className="alloc-inline">
        <span className="alloc-display"><b>{fmt(Number(allocAmt), 2)}</b><span className="tiny muted"> MT</span></span>
        <button className="btn btn-ghost btn-sm" onClick={doEdit} title="Edit qty">edit</button>
        <button className="btn btn-ghost btn-sm" onClick={() => onRemoveAllocate(lot.lot_id)} title="Remove allocation">×</button>
      </div>
    );
  }

  // STAGE or EDIT mode
  return (
    <div className="alloc-inline">
      <input type="number" step="0.01" min="0"
             value={text}
             onChange={(e) => setText(e.target.value)}
             onFocus={(e) => e.target.select()}
             onKeyDown={(e) => {
               if (e.key === 'Enter') { e.preventDefault(); mode === 'edit' ? doSave() : doAdd(); }
               if (e.key === 'Escape' && mode === 'edit') { e.preventDefault(); doCancel(); }
             }}
             placeholder="0"
             title={overStock ? `Exceeds stock ${fmt(stock, 1)} MT`
                   : overRemaining ? `Exceeds remaining ${fmt(remainingMt, 2)} MT`
                   : `max ${fmt(stock, 1)} MT`}
             className={'alloc-input' + (blocked ? ' over' : '')} />
      <button className="btn btn-ghost btn-sm" onClick={doFull} title={`Take ${fmt(Math.min(stock, remainingMt || stock), 1)} MT`}>full</button>
      {mode === 'stage' && (
        <button className="btn btn-sm btn-allocate" onClick={doAdd}
                disabled={!hasInput || blocked} title={blocked ? 'Reduce qty to allocate' : 'Add to order'}>add</button>
      )}
      {mode === 'edit' && (
        <>
          <button className="btn btn-sm btn-allocate" onClick={doSave}
                  disabled={!hasInput || blocked} title="Save edit">save</button>
          <button className="btn btn-ghost btn-sm" onClick={doCancel} title="Cancel">↶</button>
        </>
      )}
    </div>
  );
}

function OriginalReportModal({ fulfillment: f, onClose }) {
  const total = (f.lines || []).reduce((s, l) => s + (l.consume_mt || 0), 0);
  const editHistory = f.edit_history || [];
  return (
    <div className="pin-overlay" onClick={onClose}>
      <div className="report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-modal-head">
          <div>
            <div className="tiny muted">FULFILLMENT REPORT</div>
            <h3 style={{ margin: '2px 0 0' }}>{f.customer_name || f.customer_id}</h3>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>×</button>
        </div>

        <div className="report-meta">
          <div><span className="tiny muted">ID</span><span className="num">{f.id}</span></div>
          <div><span className="tiny muted">Committed</span><span className="num">{f.ts}</span></div>
          <div><span className="tiny muted">By</span><span>{f.user}</span></div>
          <div><span className="tiny muted">Requested</span><span className="num">{fmt(f.qty_requested, 2)} MT</span></div>
          <div><span className="tiny muted">Fulfilled</span><span className="num">{fmt(total, 2)} MT</span></div>
          <div><span className="tiny muted">Lots</span><span className="num">{(f.lines || []).length}</span></div>
        </div>

        <div className="tiny muted" style={{ padding: '0 16px', marginBottom: 4 }}>ALLOCATED LOTS</div>
        <table className="lots" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Lot</th>
              <th>Col</th>
              <th className="num">Stock before</th>
              <th className="num">Consumed</th>
              <th className="num">Stock after</th>
            </tr>
          </thead>
          <tbody>
            {(f.lines || []).map((l) => (
              <tr key={l.lot_id}>
                <td><b>{l.lot_no}</b></td>
                <td className="tiny muted">@{l.col_letter}</td>
                <td className="num">{fmt(l.prev_qty, 2)}</td>
                <td className="num">{fmt(l.consume_mt, 2)}</td>
                <td className="num" style={{ color: l.new_qty < 1e-3 ? 'var(--err)' : 'var(--ink)' }}>
                  {fmt(l.new_qty, 2)}{l.new_qty < 1e-3 && <span className="tiny muted"> depleted</span>}
                </td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid var(--line)' }}>
              <td colSpan="3"><b>TOTAL</b></td>
              <td className="num"><b>{fmt(total, 2)}</b></td>
              <td></td>
            </tr>
          </tbody>
        </table>

        {editHistory.length > 0 && (
          <>
            <div className="tiny muted" style={{ padding: '0 16px', marginBottom: 4 }}>EDIT HISTORY · {editHistory.length}</div>
            <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {editHistory.map((h, i) => (
                <div key={i} style={{ padding: '6px 10px', background: 'var(--bg-stripe)', borderRadius: 4, fontSize: 12 }}>
                  <div className="tiny muted">{h.ts} · {h.user}</div>
                  {(h.rewinds || []).length > 0 && (
                    <div>↶ rewound: {h.rewinds.map((r) => `${r.lot_id}(+${fmt(r.restored, 2)})`).join(' · ')}</div>
                  )}
                  {(h.appended_lots || []).length > 0 && (
                    <div>＋ new lots: {h.appended_lots.map((a) => `${a.lot_no}@${a.col_letter}`).join(' · ')}</div>
                  )}
                  {(h.applied || []).length > 0 && (
                    <div>→ applied: {h.applied.map((a) => `${a.lot_no}@${a.col_letter}(−${fmt(a.consume_mt, 2)})`).join(' · ')}</div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="pin-actions" style={{ padding: '8px 16px 16px' }}>
          <button className="btn btn-primary btn-sm" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
        </div>
      </div>
    </div>
  );
}

function LotDetail({ lot, w }) {
  const axisCell = (val, bad) => (
    <span className={'num ' + (bad ? 'delta-bad' : '')}>{signedFmt(val)}</span>
  );
  const deCell = (val, bad) => (
    <span className={'num ' + (bad ? 'delta-bad' : '')}>{fmt(val)}</span>
  );
  const sc = lot.scores || {};
  return (
    <div className="lot-detail-v2">
      {/* Row 1: 3-col MT / RT / FINAL */}
      <div className="ld-row ld-row-top">
        <div className="ld-cell">
          <div className="ld-h">Mass tone</div>
          <div className="ld-axes">
            <span>ΔL {axisCell(lot.mass_tone?.DL, w.mt.DL === false)}</span>
            <span>Δa {axisCell(lot.mass_tone?.Da, w.mt.Da === false)}</span>
            <span>Δb {axisCell(lot.mass_tone?.Db, w.mt.Db === false)}</span>
            <span>ΔE {deCell(lot.mass_tone?.DE, w.mt.DE === false)}</span>
          </div>
        </div>
        <div className="ld-cell">
          <div className="ld-h">Tint tone</div>
          <div className="ld-axes">
            <span>ΔL {axisCell(lot.tint_tone?.DL, w.rt.DL === false)}</span>
            <span>Δa {axisCell(lot.tint_tone?.Da, w.rt.Da === false)}</span>
            <span>Δb {axisCell(lot.tint_tone?.Db, w.rt.Db === false)}</span>
            <span>ΔE {deCell(lot.tint_tone?.DE, w.rt.DE === false)}</span>
            <span>str <span className={'num ' + (w.strength === false ? 'delta-bad' : '')}>{fmt(lot.tint_tone?.Strength, 1)}</span></span>
          </div>
        </div>
        <div className="ld-cell ld-final-cell">
          <div className="ld-h">Overall rank</div>
          <div className="ld-final">
            <span className="ld-final-num good">#{lot.ranks?.consensus}</span>
          </div>
        </div>
      </div>

      {/* Row 2: score breakdown (one-line strip) */}
      <div className="ld-score-strip">
        <span className="ld-score-label">Breakdown</span>
        <span className="ld-pill">
          <b>Euclid</b>
          <span>{fmt(sc.euclid, 3)}</span>
          <span className="rank">#{lot.ranks?.euclid}</span>
        </span>
        {sc.cosine_used && (
          <span className="ld-pill">
            <b>Cosine</b>
            <span>{fmt(sc.cosine, 3)}</span>
            <span className="rank">#{lot.ranks?.cosine}</span>
          </span>
        )}
        <span className="ld-pill">
          <b>KNN</b>
          <span>{fmt(sc.knn, 3)}</span>
          <span className="rank">#{lot.ranks?.knn}</span>
        </span>
        <span className="ld-score-notes">
          strength {sc.strength_dim_used ? 'included' : 'missing'}
          {!sc.cosine_used && ' · cosine skipped (target near zero)'}
        </span>
      </div>

      {/* Row 3: methods + reasons inline */}
      <div className="ld-row ld-row-foot">
        <div className="ld-cell">
          <span className="ld-h-inline">Methods present:</span>{' '}
          <span className="muted">{(lot.present_methods || []).join(' · ') || '—'}</span>
        </div>
        {!w.all && (
          <div className="ld-cell ld-reasons">
            <span className="ld-h-inline err">Out of spec:</span>{' '}
            <span className="err">{(w.reasons || []).join(' · ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ============== ROOT ==============
export default function DashboardV3({ user, onLogout }) {
  const [screen, setScreen] = useState('home');
  const [customers, setCustomers] = useState([]);
  const [master, setMaster] = useState({ methods: [], lots: [], totals: {} });
  const [masterLock, setMasterLock] = useState({ locked: false });
  const [customerId, setCustomerId] = useState('');
  const [qty, setQty] = useState('');
  const [requiredTests, setRequiredTests] = useState([]);
  const [gradeStrict, setGradeStrict] = useState(true);
  const [coaPreview, setCoaPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [matchResp, setMatchResp] = useState(null);
  const [allocated, setAllocated] = useState(new Map());
  const [topN, setTopN] = useState(12);
  const [showOnlyWithin, setShowOnlyWithin] = useState(true);
  const [showOnlyDirection, setShowOnlyDirection] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState(null);
  const [editingFulfillment, setEditingFulfillment] = useState(null);
  const [homeTab, setHomeTab] = useState('new');
  const [newLots, setNewLots] = useState([]);

  function addNewLot(spec) {
    setNewLots((nl) => [...nl, spec]);
    setAllocated((prev) => {
      const next = new Map(prev);
      next.set(`${spec.lot_no}@__new__`, Number(spec.qty_consume || 0));
      return next;
    });
  }
  function removeNewLot(lot_no) {
    setNewLots((nl) => nl.filter((x) => x.lot_no !== lot_no));
    setAllocated((prev) => {
      const next = new Map(prev);
      next.delete(`${lot_no}@__new__`);
      return next;
    });
  }

  // bootstrap
  useEffect(() => {
    (async () => {
      try {
        const [cs, ms] = await Promise.all([api('/customers'), api('/master')]);
        setCustomers(cs.customers || []);
        setMaster(ms);
      } catch (e) { setError(String(e)); }
    })();
  }, []);

  // Poll master lock state every 5s. When the lab tech opens Master.xlsx in
  // Excel (either via the "Edit Master" button OR directly on the filesystem),
  // every open browser session flips into offline mode within ~5s. When the
  // file is closed, sessions auto-refresh master and resume.
  useEffect(() => {
    let cancelled = false;
    let wasLocked = false;
    async function tick() {
      try {
        const r = await fetchWithRenderWake(`${API}/api/v3/master/lock`);
        const d = await r.json();
        if (cancelled) return;
        setMasterLock(d);
        if (wasLocked && !d.locked) {
          // Just came back online — refresh master so any external edits propagate.
          try { const ms = await api('/master'); if (!cancelled) setMaster(ms); } catch {}
        }
        wasLocked = !!d.locked;
      } catch {
        /* network blip — keep previous state */
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // load COA preview when customer changes
  useEffect(() => {
    if (!customerId) { setCoaPreview(null); return; }
    setLoadingPreview(true);
    api(`/customer/${encodeURIComponent(customerId)}`)
      .then((d) => setCoaPreview(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingPreview(false));
  }, [customerId]);

  const ranked = matchResp?.ranked || [];

  const onMatch = useCallback(async (opts = {}) => {
    try {
      const d = await api('/match', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: customerId,
          qty: Number(qty),
          required_tests: requiredTests,
          grade_strict: gradeStrict,
          in_spec_only: opts.in_spec_only ?? showOnlyWithin,
        }),
      });
      setMatchResp(d);
      if (!opts.keepAlloc) setAllocated(new Map());
      if (opts.goResults !== false) setScreen('results');
    } catch (e) { setError(String(e)); }
  }, [customerId, qty, requiredTests, gradeStrict, showOnlyWithin]);

  // Re-fetch when the spec-toggle changes while on results screen
  // SKIP during edit-fulfillment: pre-populated allocations would be wiped.
  useEffect(() => {
    if (screen === 'results' && customerId && !editingFulfillment && !masterLock.locked) {
      onMatch({ goResults: false, keepAlloc: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOnlyWithin, requiredTests, masterLock.locked]);

  const onAutoFulfill = useCallback(() => {
    if (!matchResp) return;
    const next = new Map();
    (matchResp.auto_fulfill || []).forEach((p) => next.set(p.lot_id || p.lot_no, p.consume_mt));
    setAllocated(next);
  }, [matchResp]);

  function onToggleAllocate(lot_id) {
    setAllocated((prev) => {
      const next = new Map(prev);
      if (next.has(lot_id)) { next.delete(lot_id); return next; }
      const lot = ranked.find((l) => l.lot_id === lot_id);
      if (!lot) return next;
      let already = 0;
      for (const v of next.values()) already += v;
      const remaining = Math.max(0, Number(qty) - already);
      const take = remaining > 0 ? Math.min(lot.qty_mt, remaining) : lot.qty_mt;
      next.set(lot_id, +take.toFixed(3));
      return next;
    });
  }
  function onSetAllocateQty(lot_id, val) {
    setAllocated((prev) => {
      const next = new Map(prev);
      const lot = ranked.find((l) => l.lot_id === lot_id);
      if (!lot) return next;
      // Empty string OR NaN -> set to 0 (keep allocation slot so user can keep typing)
      if (val === '' || val === null || val === undefined) {
        next.set(lot_id, 0);
        return next;
      }
      const v = Number(val);
      if (!isFinite(v)) return next;
      // Don't cap — let user enter > stock so they see the red warning
      next.set(lot_id, +Math.max(0, v).toFixed(3));
      return next;
    });
  }
  function onAllocateFullLot(lot_id) {
    setAllocated((prev) => {
      const next = new Map(prev);
      const lot = ranked.find((l) => l.lot_id === lot_id);
      if (!lot) return next;
      const effective = lot._original ? (Number(lot.qty_mt) + Number(lot._origConsume || 0)) : Number(lot.qty_mt);
      next.set(lot_id, +effective.toFixed(3));
      return next;
    });
  }
  function onRemoveAllocate(lot_id) {
    setAllocated((prev) => {
      const next = new Map(prev);
      next.delete(lot_id);
      return next;
    });
  }

  async function onCommit() {
    if (allocated.size === 0) return;
    const allocations = Array.from(allocated.entries()).map(([lot_id, consume_mt]) => {
      const lot = ranked.find((l) => l.lot_id === lot_id);
      return { lot_id, lot_no: lot?.lot_no, consume_mt };
    });
    setCommitting(true);
    try {
      if (editingFulfillment) {
        const lines = Array.from(allocated.entries()).map(([lot_id, consume_mt]) => {
          if (lot_id.endsWith('@__new__')) {
            return { lot_no: lot_id.replace('@__new__', ''), consume_mt };
          }
          const lot = ranked.find((l) => l.lot_id === lot_id);
          return { lot_id, lot_no: lot?.lot_no, consume_mt };
        });
        const r = await fetchWithRenderWake(`${API}/api/v3/fulfillments/${editingFulfillment.id}/edit`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user: user?.username,
            new_lots: newLots,
            lines,
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `${r.status}`);
        setEditingFulfillment(null);
        setNewLots([]);
      } else {
      // Snapshot per-lot match info so edit-mode (within 24h) can still show
      // ranks/spec/dir/super even after the lot is depleted in master.
      const snapshot = {};
      allocations.forEach(({ lot_id }) => {
        const lot = ranked.find((l) => l.lot_id === lot_id);
        if (!lot) return;
        snapshot[lot_id] = {
          grade: lot.grade,
          mass_tone: lot.mass_tone,
          tint_tone: lot.tint_tone,
          ranks: lot.ranks,
          scores: lot.scores,
          within: lot.within,
          direction: lot.direction,
          is_super: lot.is_super,
          present_methods: lot.present_methods,
          all_blocks: lot.all_blocks,
          last_edited: lot.last_edited,
        };
      });
      await api('/fulfill', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: customerId,
          user: user?.username,
          qty_requested: Number(qty),
          allocations,
          snapshot,
        }),
      });
      }
      // Refresh master, reset workflow, return to home
      const ms = await api('/master');
      setMaster(ms);
      setAllocated(new Map());
      setMatchResp(null);
      setCustomerId('');
      setQty('');
      setRequiredTests([]);
      setScreen('home');
    } catch (e) {
      setError(String(e));
    } finally { setCommitting(false); }
  }

  async function onCancelFulfillment() {
    if (!editingFulfillment) return;
    setCommitting(true);
    try {
      const r = await fetchWithRenderWake(`${API}/api/v3/fulfillments/${editingFulfillment.id}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: user?.username, pin: sessionStorage.getItem('v3_pin') || '' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `${r.status}`);
      const ms = await api('/master');
      setMaster(ms);
      setEditingFulfillment(null);
      setNewLots([]);
      setAllocated(new Map());
      setMatchResp(null);
      setCustomerId('');
      setQty('');
      setRequiredTests([]);
      setHomeTab('recent');
      setScreen('home');
    } catch (e) {
      setError(String(e));
    } finally { setCommitting(false); }
  }

  async function onSaveOverride(patch, pin) {
    const r = await fetchWithRenderWake(`${API}/api/v3/customer/${encodeURIComponent(customerId)}/override`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, patch }),
    });
    if (!r.ok) throw new Error('PIN rejected');
    const d = await r.json();
    setCoaPreview(d.effective);
    // Override = user wants to see everything to gauge impact of edit
    setShowOnlyWithin(false);
    await onMatch({ in_spec_only: false });
  }

  async function onEditFulfillment(f, pin) {
    const v = await fetchWithRenderWake(`${API}/api/v3/verify_pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!v.ok) throw new Error('PIN rejected');
    sessionStorage.setItem('v3_pin', pin);
    setCustomerId(f.customer_id);
    setQty(String(f.qty_requested));
    setEditingFulfillment(f);
    setNewLots([]);
    const [d, freshMaster] = await Promise.all([
      api('/match', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: f.customer_id,
          qty: Number(f.qty_requested),
          required_tests: [],
          grade_strict: true,
          in_spec_only: false,
        }),
      }),
      api('/master'),
    ]);
    setMaster(freshMaster);
    const rankedOrig = d.ranked || [];
    const masterLots = (freshMaster?.lots) || [];
    const masterById = new Map(masterLots.map((m) => [m.lot_id, m]));
    const next = new Map();
    const merged = [];
    (f.lines || []).forEach((l) => {
      const lotId = l.lot_id || `${l.lot_no}@${l.col_letter}`;
      const inRanked = rankedOrig.find((x) => x.lot_id === lotId);
      if (inRanked) {
        merged.push({ ...inRanked, _original: true, _origConsume: Number(l.consume_mt) });
        next.set(inRanked.lot_id, Number(l.consume_mt));
      } else {
        // Lot was filtered out of /match — usually because it's now depleted
        // (qty_mt == 0 after the original commit). Prefer the snapshot captured
        // at commit time so ranks/spec/dir/super persist through the 24h edit
        // window. Fall back to master block data if snapshot wasn't captured
        // (older fulfillments pre-snapshot rollout).
        const m = masterById.get(lotId);
        const masterQty = m ? Number(m.qty_mt || 0) : 0;
        const snap = l.snapshot || {};
        const blocks = snap.all_blocks || (m && m.blocks) || {};
        const mtB = snap.mass_tone || blocks['Method I a'] || {};
        const rtB = snap.tint_tone || blocks['Method I b'] || {};
        const present = snap.present_methods || (m && m.present_methods) || [];
        merged.push({
          lot_id: lotId,
          lot_no: l.lot_no,
          col_letter: l.col_letter,
          grade: snap.grade ?? (m ? m.grade : ''),
          qty_mt: masterQty,
          last_edited: snap.last_edited ?? (m ? m.last_edited : null),
          mass_tone: { DL: mtB.DL ?? null, Da: mtB.Da ?? null, Db: mtB.Db ?? null, DE: mtB.DE ?? null },
          tint_tone: { DL: rtB.DL ?? null, Da: rtB.Da ?? null, Db: rtB.Db ?? null, DE: rtB.DE ?? null, Strength: rtB.Strength ?? null },
          all_blocks: blocks,
          present_methods: present,
          is_super: snap.is_super ?? (present.length > 2),
          scores: snap.scores || {},
          ranks: snap.ranks || { euclid: '—', cosine: '—', knn: '—', age: '—', consensus: 0 },
          within: snap.within || { all: true, mt: {}, rt: {}, strength: true, reasons: [] },
          direction: snap.direction || { all: true, mt: {}, rt: {}, reasons: [] },
          _original: true,
          _origConsume: Number(l.consume_mt),
        });
        next.set(lotId, Number(l.consume_mt));
      }
    });
    const origIds = new Set(merged.map((m) => m.lot_id));
    rankedOrig.forEach((r) => { if (!origIds.has(r.lot_id)) merged.push(r); });
    setMatchResp({ ...d, ranked: merged });
    setAllocated(next);
    setTopN(Math.max(12, (f.lines || []).length + 10));
    setShowOnlyWithin(false);
    setScreen('results');
  }

  async function onRevertOverride() {
    const r = await fetchWithRenderWake(`${API}/api/v3/customer/${encodeURIComponent(customerId)}/override/clear`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) throw new Error('revert failed');
    const d = await r.json();
    setCoaPreview(d.effective);
    setShowOnlyWithin(true);
    await onMatch({ in_spec_only: true });
  }

  // Overrides are session-scoped: clear any active override when switching
  // customers or leaving the app entirely so they don't carry over.
  useEffect(() => {
    const cid = customerId;
    return () => {
      if (!cid) return;
      // Fire-and-forget; failure (e.g. backend down) shouldn't block teardown.
      fetchWithRenderWake(`${API}/api/v3/customer/${encodeURIComponent(cid)}/override/clear`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        keepalive: true,
      }).catch(() => {});
    };
  }, [customerId]);

  const customer = matchResp?.customer || coaPreview;

  return (
    <div className="desktop">
      <div className={'window' + (masterLock.locked ? ' app-offline' : '')} data-screen-label={screen === 'home' ? '01 Intake' : '02 Match Results'}>
        {masterLock.locked && (
          <div className="offline-banner">
            <span className="offline-dot" />
            <b>APP OFFLINE</b>
            <span className="sep">·</span>
            <span>Master.xlsx is being edited{masterLock.owner && masterLock.owner !== 'unknown' ? ` by ${masterLock.owner}` : ''}.</span>
            <span className="sep">·</span>
            <span className="tiny muted">Close the file to resume. The app will auto-recover within 5 s.</span>
          </div>
        )}
        {error && (
          <div style={{ background: 'var(--warn-soft)', color: 'var(--ink)', padding: '6px 12px', fontSize: 12, borderBottom: '1px solid var(--line)' }}>
            ⚠ {error} <button onClick={() => setError(null)} style={{ marginLeft: 8 }}>dismiss</button>
          </div>
        )}
        <div className="body">
          {screen === 'home' ? (
            <HomeScreen
              customers={customers} master={master} user={user}
              customerId={customerId} qty={qty}
              requiredTests={requiredTests} gradeStrict={gradeStrict}
              onSelect={setCustomerId} onQty={setQty}
              onTests={setRequiredTests} onGradeStrict={setGradeStrict}
              onMatch={onMatch}
              coaPreview={coaPreview} loadingPreview={loadingPreview}
              onEditFulfillment={onEditFulfillment}
              onReloadMaster={async () => { const ms = await api('/master'); setMaster(ms); }}
              tab={homeTab} onTabChange={setHomeTab}
              masterLock={masterLock}
            />
          ) : (
            customer && <ResultsScreen
            customer={customer} qty={Number(qty)} ranked={ranked}
              allocated={allocated}
              onToggleAllocate={onToggleAllocate}
              onSetAllocateQty={onSetAllocateQty}
              onAllocateFullLot={onAllocateFullLot}
              onRemoveAllocate={onRemoveAllocate}
              onAutoFulfill={onAutoFulfill}
              onClear={() => setAllocated(new Map())}
              onCommit={onCommit}
              onSaveOverride={onSaveOverride}
              onRevertOverride={onRevertOverride}
              onBack={() => {
                const wasEditing = !!editingFulfillment;
                setEditingFulfillment(null);
                setNewLots([]);
                if (wasEditing) setHomeTab('recent');
                setScreen('home');
              }}
              topN={topN} showOnlyWithin={showOnlyWithin} showOnlyDirection={showOnlyDirection}
              onTopN={setTopN} onShowOnlyWithin={setShowOnlyWithin} onShowOnlyDirection={setShowOnlyDirection}
              methods={master.methods || []} requiredTests={requiredTests} onTests={setRequiredTests}
              onCancelFulfillment={onCancelFulfillment}
              masterLock={masterLock}
              committing={committing}
              editingFulfillment={editingFulfillment}
              newLots={newLots}
              onAddNewLot={addNewLot}
              onRemoveNewLot={removeNewLot}
            />
          )}
        </div>
        <StatusBar screen={screen} customer={customer} ranked={ranked} qty={qty} totals={master.totals || {}} user={user} onLogout={onLogout} />
      </div>
    </div>
  );
}
