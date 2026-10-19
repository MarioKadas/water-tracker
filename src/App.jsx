import { useEffect, useMemo, useRef, useState } from 'react'

const UNITS = {
  ml: { label: 'ml', f: 1, digits: 0 },
  oz: { label: 'fl oz', f: 29.5735, digits: 1 },
  cup: { label: 'cups', f: 236.588, digits: 2 },
}
const DEFAULT_CONTAINERS = [
  { id: 'c1', name: 'Small glass', ml: 150 },
  { id: 'c2', name: 'Glass', ml: 250 },
  { id: 'c3', name: 'Bottle', ml: 500 },
  { id: 'c4', name: 'Large bottle', ml: 750 },
]
const DEFAULT_REMINDERS = { on: false, every: 60, from: 8, to: 22 }

const uid = () => Math.random().toString(36).slice(2, 9)
const dayKey = (t) => new Date(t).toLocaleDateString('en-CA')
const toUnit = (ml, u) => +(ml / UNITS[u].f).toFixed(UNITS[u].digits)
const fromUnit = (v, u) => Math.round(v * UNITS[u].f)

function useStored(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage unavailable */
    }
  }, [key, value])
  return [value, setValue]
}

/* ---------- CSV helpers ---------- */
function toCsv(entries) {
  const rows = [...entries]
    .sort((a, b) => a.ts - b.ts)
    .map((e) => `${new Date(e.ts).toISOString()},${e.ml},"${(e.label || '').replace(/"/g, '""')}"`)
  return ['timestamp,ml,label', ...rows].join('\n')
}

function splitCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

function parseCsv(text) {
  const entries = []
  let skipped = 0
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return
    const [t, ml, label = ''] = splitCsvLine(line)
    const ts = Date.parse(t)
    const amount = Number(ml)
    if (Number.isNaN(ts) || !(amount > 0)) {
      if (i > 0) skipped++
      return
    }
    entries.push({ id: uid(), ts, ml: Math.round(amount), label: label.trim() })
  })
  return { entries, skipped }
}

/* ---------- Vessel ---------- */
const GLASS = 'M30 20 H170 L152 262 Q151 272 140 272 H60 Q49 272 48 262 Z'

function Vessel({ pct }) {
  const p = Math.min(pct, 1)
  const y = p === 0 ? 300 : 272 - p * 252 - 10
  return (
    <svg className="vessel" viewBox="0 0 200 292" role="img" aria-label={`${Math.round(pct * 100)}% of daily goal`}>
      <defs>
        <clipPath id="glass"><path d={GLASS} /></clipPath>
      </defs>
      <path d={GLASS} className="glass-fill" />
      <g clipPath="url(#glass)">
        <g style={{ transform: `translateY(${y}px)`, transition: 'transform .9s cubic-bezier(.3,.7,.2,1)' }}>
          <path
            className="wave"
            d="M-200 10 Q-175 0 -150 10 T-100 10 T-50 10 T0 10 T50 10 T100 10 T150 10 T200 10 T250 10 T300 10 V320 H-200Z"
          />
        </g>
      </g>
      <path d={GLASS} className="glass-line" />
    </svg>
  )
}

/* ---------- App ---------- */
export default function App() {
  const [entries, setEntries] = useStored('wt.entries', [])
  const [goal, setGoal] = useStored('wt.goal', 2200)
  const [unit, setUnit] = useStored('wt.unit', 'ml')
  const [containers, setContainers] = useStored('wt.containers', DEFAULT_CONTAINERS)
  const [rem, setRem] = useStored('wt.reminders', DEFAULT_REMINDERS)
  const [theme, setTheme] = useStored(
    'wt.theme',
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  const [customAmount, setCustomAmount] = useState('')
  const [weight, setWeight] = useState('')
  const [newBox, setNewBox] = useState({ name: '', amount: '' })
  const [status, setStatus] = useState('')
  const fileRef = useRef(null)
  const lastReminder = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const u = UNITS[unit]
  const show = (ml) => toUnit(ml, unit)

  const todayKey = dayKey(Date.now())
  const todayEntries = useMemo(
    () => entries.filter((e) => dayKey(e.ts) === todayKey).sort((a, b) => b.ts - a.ts),
    [entries, todayKey]
  )
  const total = todayEntries.reduce((s, e) => s + e.ml, 0)
  const pct = goal > 0 ? total / goal : 0

  const week = useMemo(() => {
    const byDay = {}
    entries.forEach((e) => { byDay[dayKey(e.ts)] = (byDay[dayKey(e.ts)] || 0) + e.ml })
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      days.push({
        key: dayKey(d),
        label: d.toLocaleDateString(undefined, { weekday: 'short' }),
        ml: byDay[dayKey(d)] || 0,
      })
    }
    let streak = 0
    const d = new Date()
    if ((byDay[dayKey(d)] || 0) < goal) d.setDate(d.getDate() - 1)
    while ((byDay[dayKey(d)] || 0) >= goal && goal > 0) {
      streak++
      d.setDate(d.getDate() - 1)
    }
    return { days, streak }
  }, [entries, goal])

  /* smart reminders: skip when ahead of pace, goal reached, or outside active hours */
  useEffect(() => {
    if (!rem.on || typeof Notification === 'undefined') return
    const id = setInterval(() => {
      if (Notification.permission !== 'granted') return
      const now = new Date()
      const h = now.getHours() + now.getMinutes() / 60
      if (h < rem.from || h >= rem.to) return
      if (total >= goal) return
      const pace = goal * ((h - rem.from) / (rem.to - rem.from))
      if (total >= pace) return
      if (Date.now() - lastReminder.current < rem.every * 60000) return
      lastReminder.current = Date.now()
      new Notification('Time for some water', {
        body: `You're at ${show(total)} of ${show(goal)} ${u.label} today.`,
      })
    }, 60000)
    return () => clearInterval(id)
  })

  const toggleReminders = async () => {
    if (!rem.on) {
      if (typeof Notification === 'undefined') {
        setStatus('This browser does not support notifications.')
        return
      }
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        setStatus('Allow notifications in your browser settings to get reminders.')
        return
      }
    }
    setRem({ ...rem, on: !rem.on })
  }

  const add = (ml, label = '') => {
    if (!(ml > 0)) return
    setEntries([...entries, { id: uid(), ts: Date.now(), ml: Math.round(ml), label }])
  }
  const undo = () => {
    if (todayEntries[0]) setEntries(entries.filter((e) => e.id !== todayEntries[0].id))
  }
  const editEntry = (id, value) => {
    const ml = fromUnit(Number(value), unit)
    if (ml > 0) setEntries(entries.map((e) => (e.id === id ? { ...e, ml } : e)))
  }
  const removeEntry = (id) => setEntries(entries.filter((e) => e.id !== id))

  const addCustom = (e) => {
    e.preventDefault()
    add(fromUnit(Number(customAmount), unit), 'Custom')
    setCustomAmount('')
  }
  const addContainer = (e) => {
    e.preventDefault()
    const ml = fromUnit(Number(newBox.amount), unit)
    if (!newBox.name.trim() || !(ml > 0)) return
    setContainers([...containers, { id: uid(), name: newBox.name.trim(), ml }])
    setNewBox({ name: '', amount: '' })
  }

  const suggestGoal = () => {
    const kg = Number(weight)
    if (kg > 0) setGoal(Math.round((kg * 35) / 50) * 50)
  }

  const exportCsv = () => {
    const blob = new Blob([toCsv(entries)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `water-log-${todayKey}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setStatus(`Exported ${entries.length} entries.`)
  }
  const importCsv = (ev) => {
    const file = ev.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const { entries: parsed, skipped } = parseCsv(String(reader.result))
      const seen = new Set(entries.map((e) => `${e.ts}|${e.ml}`))
      const fresh = parsed.filter((e) => !seen.has(`${e.ts}|${e.ml}`))
      setEntries([...entries, ...fresh])
      setStatus(
        `Imported ${fresh.length} new entries` +
          (parsed.length - fresh.length ? `, ${parsed.length - fresh.length} duplicates ignored` : '') +
          (skipped ? `, ${skipped} invalid rows skipped` : '') +
          '.'
      )
    }
    reader.readAsText(file)
    ev.target.value = ''
  }

  const maxWeek = Math.max(goal, ...week.days.map((d) => d.ml))

  return (
    <div className="app">
      <header className="top">
        <h1>Water</h1>
        <div className="top-actions">
          <button className="ghost" onClick={exportCsv}>Export CSV</button>
          <button className="ghost" onClick={() => fileRef.current?.click()}>Import CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={importCsv} />
          <button
            className="ghost icon"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title="Toggle theme"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      {status && (
        <p className="status" role="status">
          {status} <button className="link" onClick={() => setStatus('')}>Dismiss</button>
        </p>
      )}

      <main className="grid">
        <section className="today">
          <Vessel pct={pct} />
          <div className="readout">
            <p className="big">{show(total)}</p>
            <p className="of">of {show(goal)} {u.label} · {Math.min(Math.round(pct * 100), 999)}%</p>
            <p className="streak">
              {week.streak > 0
                ? `${week.streak}-day streak. Keep it going.`
                : 'Hit your goal today to start a streak.'}
            </p>
          </div>

          <div className="quick">
            {containers.map((c) => (
              <button key={c.id} className="chip" onClick={() => add(c.ml, c.name)}>
                <span>{c.name}</span>
                <b>+{show(c.ml)} {u.label}</b>
              </button>
            ))}
          </div>

          <form className="inline" onSubmit={addCustom}>
            <label className="sr" htmlFor="custom">Custom amount in {u.label}</label>
            <input
              id="custom" type="number" min="0" step="any" placeholder={`Custom (${u.label})`}
              value={customAmount} onChange={(e) => setCustomAmount(e.target.value)}
            />
            <button className="solid" type="submit">Add</button>
          </form>
        </section>

        <div className="side">
          <section>
            <div className="sec-head">
              <h2>Today’s log</h2>
              <button className="link" onClick={undo} disabled={!todayEntries.length}>Undo last</button>
            </div>
            {todayEntries.length === 0 ? (
              <p className="muted">Nothing logged yet. Tap a container to add your first drink.</p>
            ) : (
              <ul className="log">
                {todayEntries.map((e) => (
                  <li key={e.id}>
                    <time>{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    <span className="lbl">{e.label || 'Water'}</span>
                    <input
                      aria-label="Amount" type="number" min="0" step="any"
                      defaultValue={show(e.ml)} key={`${e.id}-${unit}-${e.ml}`}
                      onBlur={(ev) => editEntry(e.id, ev.target.value)}
                    />
                    <span className="muted">{u.label}</span>
                    <button className="link" onClick={() => removeEntry(e.id)} aria-label="Remove entry">Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>Last 7 days</h2>
            <div className="bars" role="img" aria-label="Daily intake for the last 7 days">
              <div className="goal-line" style={{ bottom: `${(goal / maxWeek) * 100}%` }} />
              {week.days.map((d) => (
                <div key={d.key} className="bar-col">
                  <div className="bar-track">
                    <div
                      className={`bar ${d.ml >= goal ? 'met' : ''}`}
                      style={{ height: `${(d.ml / maxWeek) * 100}%` }}
                      title={`${show(d.ml)} ${u.label}`}
                    />
                  </div>
                  <span>{d.label}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2>Settings</h2>
            <div className="row">
              <label htmlFor="unit">Units</label>
              <select id="unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {Object.entries(UNITS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div className="row">
              <label htmlFor="goal">Daily goal ({u.label})</label>
              <input
                id="goal" type="number" min="0" step="any" value={show(goal)}
                onChange={(e) => { const ml = fromUnit(Number(e.target.value), unit); if (ml >= 0) setGoal(ml) }}
              />
            </div>
            <div className="row">
              <label htmlFor="kg">Suggest from weight (kg)</label>
              <span className="inline">
                <input id="kg" type="number" min="0" value={weight} onChange={(e) => setWeight(e.target.value)} />
                <button className="ghost" onClick={suggestGoal}>Suggest</button>
              </span>
            </div>
            <p className="muted small">Needs vary with climate and activity, so treat this as a starting point.</p>

            <h3>Containers</h3>
            <ul className="boxes">
              {containers.map((c) => (
                <li key={c.id}>
                  <span>{c.name} · {show(c.ml)} {u.label}</span>
                  <button className="link" onClick={() => setContainers(containers.filter((x) => x.id !== c.id))}>Remove</button>
                </li>
              ))}
            </ul>
            <form className="inline" onSubmit={addContainer}>
              <input placeholder="Name" value={newBox.name} onChange={(e) => setNewBox({ ...newBox, name: e.target.value })} aria-label="Container name" />
              <input type="number" min="0" step="any" placeholder={u.label} value={newBox.amount} onChange={(e) => setNewBox({ ...newBox, amount: e.target.value })} aria-label="Container size" />
              <button className="ghost" type="submit">Save</button>
            </form>

            <h3>Reminders</h3>
            <div className="row">
              <label htmlFor="rem">Smart reminders</label>
              <button id="rem" className={`switch ${rem.on ? 'on' : ''}`} role="switch" aria-checked={rem.on} onClick={toggleReminders}>
                <span />
              </button>
            </div>
            {rem.on && (
              <div className="rem-opts">
                <label>Every <input type="number" min="15" step="15" value={rem.every} onChange={(e) => setRem({ ...rem, every: Number(e.target.value) })} /> min</label>
                <label>From <input type="number" min="0" max="23" value={rem.from} onChange={(e) => setRem({ ...rem, from: Number(e.target.value) })} />:00</label>
                <label>To <input type="number" min="1" max="24" value={rem.to} onChange={(e) => setRem({ ...rem, to: Number(e.target.value) })} />:00</label>
              </div>
            )}
            <p className="muted small">
              Reminders pause when you’re ahead of pace or have hit your goal. They only fire while this tab is open.
            </p>
          </section>
        </div>
      </main>
      <footer>
            <details>
              <summary>
                Limitations
              </summary>
              <ul>
                <li>Reminders only fire while the tab is open.</li>
                <li>Data is saved in the browser’s localStorage, so it stays on one device. CSV export is your backup and transfer route.</li>
                <li>Streaks compare past days to your current goal, not the goal you had then.</li>
              </ul>
            </details>
      </footer>
    </div>
  )
}
