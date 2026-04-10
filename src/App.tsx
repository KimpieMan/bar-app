import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import * as XLSX from 'xlsx'
import { format } from 'date-fns'
import { supabase } from './supabase'
import type { Group, Person, Transaction } from './types'

const TICK_VALUE_EUR = 0.85
const GROUP_STORAGE_KEY = 'bar-app-group-code'
const FRIDAY_STORAGE_KEY = 'bar-app-last-friday'

type PersonBalance = Person & { ticks: number; payments: number; balance: number }
type Notice = { id: string; message: string }
type TabKey = 'personen' | 'invoer' | 'historie' | 'rapportage' | 'instellingen'

const toDateInput = (value: Date) => format(value, 'yyyy-MM-dd')
const defaultFriday = () => {
  const now = new Date()
  const day = now.getDay()
  const diff = (day + 2) % 7
  now.setDate(now.getDate() - diff)
  return toDateInput(now)
}

const parseBulkNames = (raw: string) =>
  raw
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean)

function App() {
  const [groupCodeInput, setGroupCodeInput] = useState('')
  const [groupName, setGroupName] = useState('Scouting Bar')
  const [group, setGroup] = useState<Group | null>(null)
  const [persons, setPersons] = useState<Person[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [search, setSearch] = useState('')
  const [selectedPersonId, setSelectedPersonId] = useState<string>('')
  const [bulkNames, setBulkNames] = useState('')
  const [newTickCount, setNewTickCount] = useState(1)
  const [tickDate, setTickDate] = useState(localStorage.getItem(FRIDAY_STORAGE_KEY) ?? defaultFriday())
  const [paymentAmount, setPaymentAmount] = useState<number>(0)
  const [editing, setEditing] = useState<Record<string, { amount: number; date: string }>>({})
  const [notices, setNotices] = useState<Notice[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('personen')

  const selectedPerson = useMemo(
    () => persons.find((person) => person.id === selectedPersonId) ?? null,
    [persons, selectedPersonId],
  )

  const personBalances: PersonBalance[] = useMemo(() => {
    return persons
      .map((person) => {
        const ownEntries = transactions.filter((entry) => entry.person_id === person.id)
        const ticks = ownEntries
          .filter((entry) => entry.type === 'tick')
          .reduce((sum, entry) => sum + entry.amount, 0)
        const payments = ownEntries
          .filter((entry) => entry.type === 'payment')
          .reduce((sum, entry) => sum + entry.amount, 0)
        return { ...person, ticks, payments, balance: ticks - payments }
      })
      .sort((a, b) => b.balance - a.balance)
  }, [persons, transactions])

  const filteredBalances = useMemo(
    () => personBalances.filter((person) => person.name.toLowerCase().includes(search.toLowerCase().trim())),
    [personBalances, search],
  )

  const monthlyRows = useMemo(() => {
    const map = new Map<string, { ticks: number; payments: number }>()
    transactions.forEach((entry) => {
      const month = entry.event_date.slice(0, 7)
      const current = map.get(month) ?? { ticks: 0, payments: 0 }
      if (entry.type === 'tick') current.ticks += entry.amount
      if (entry.type === 'payment') current.payments += entry.amount
      map.set(month, current)
    })
    return [...map.entries()]
      .map(([month, values]) => ({
        month,
        ticks: values.ticks,
        payments: values.payments,
        debt: values.ticks - values.payments,
      }))
      .sort((a, b) => b.month.localeCompare(a.month))
  }, [transactions])

  const yearlyRows = useMemo(() => {
    const map = new Map<string, { ticks: number; payments: number }>()
    transactions.forEach((entry) => {
      const year = entry.event_date.slice(0, 4)
      const current = map.get(year) ?? { ticks: 0, payments: 0 }
      if (entry.type === 'tick') current.ticks += entry.amount
      if (entry.type === 'payment') current.payments += entry.amount
      map.set(year, current)
    })
    return [...map.entries()]
      .map(([year, values]) => ({
        year,
        ticks: values.ticks,
        payments: values.payments,
        debt: values.ticks - values.payments,
      }))
      .sort((a, b) => b.year.localeCompare(a.year))
  }, [transactions])

  useEffect(() => {
    localStorage.setItem(FRIDAY_STORAGE_KEY, tickDate)
  }, [tickDate])

  useEffect(() => {
    const storedCode = localStorage.getItem(GROUP_STORAGE_KEY)
    if (storedCode) {
      setGroupCodeInput(storedCode)
      void joinGroup(storedCode)
    }
  }, [])

  useEffect(() => {
    if (!group) return
    const personsChannel = supabase
      .channel(`persons-${group.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'persons', filter: `group_id=eq.${group.id}` }, () => {
        void fetchGroupData(group.id)
      })
      .subscribe()

    const txChannel = supabase
      .channel(`transactions-${group.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'transactions', filter: `group_id=eq.${group.id}` },
        () => {
          void fetchGroupData(group.id)
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(personsChannel)
      void supabase.removeChannel(txChannel)
    }
  }, [group])

  const addNotice = (message: string) => {
    const item = { id: `${Date.now()}-${Math.random()}`, message }
    setNotices((previous) => [item, ...previous].slice(0, 3))
    setTimeout(() => {
      setNotices((previous) => previous.filter((n) => n.id !== item.id))
    }, 3500)
  }

  const fetchGroupData = async (groupId: string) => {
    const [{ data: pData, error: pErr }, { data: tData, error: tErr }] = await Promise.all([
      supabase.from('persons').select('*').eq('group_id', groupId).order('name'),
      supabase.from('transactions').select('*').eq('group_id', groupId).order('event_date', { ascending: false }),
    ])
    if (pErr) return setError(pErr.message)
    if (tErr) return setError(tErr.message)
    setPersons((pData ?? []) as Person[])
    setTransactions((tData ?? []) as Transaction[])
  }

  const generateGroupCode = () => Math.random().toString(36).slice(2, 8).toUpperCase()

  const createGroup = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    const code = generateGroupCode()
    setLoading(true)
    const { data, error: createError } = await supabase
      .from('groups')
      .insert({ code, name: groupName.trim() || 'Scouting Bar' })
      .select('*')
      .single()
    setLoading(false)
    if (createError || !data) {
      setError(createError?.message ?? 'Groep kon niet worden aangemaakt.')
      return
    }
    setGroup(data as Group)
    setGroupCodeInput(code)
    localStorage.setItem(GROUP_STORAGE_KEY, code)
    await fetchGroupData(data.id)
  }

  const joinGroup = async (codeRaw?: string) => {
    setError('')
    const code = (codeRaw ?? groupCodeInput).trim().toUpperCase()
    if (!code) return
    setLoading(true)
    const { data, error: joinError } = await supabase.from('groups').select('*').eq('code', code).single()
    setLoading(false)
    if (joinError || !data) {
      setError('Groep niet gevonden. Controleer de code.')
      return
    }
    setGroup(data as Group)
    setGroupCodeInput(code)
    localStorage.setItem(GROUP_STORAGE_KEY, code)
    await fetchGroupData(data.id)
  }

  const addPeopleBulk = async (e: FormEvent) => {
    e.preventDefault()
    if (!group) return
    const names = parseBulkNames(bulkNames).slice(0, 60)
    if (!names.length) return
    const payload = names.map((name) => ({ group_id: group.id, name }))
    const { error: insertError } = await supabase.from('persons').insert(payload)
    if (insertError) {
      setError(insertError.message)
      return
    }
    setBulkNames('')
    await fetchGroupData(group.id)
  }

  const removePerson = async (personId: string) => {
    if (!group) return
    await supabase.from('transactions').delete().eq('person_id', personId).eq('group_id', group.id)
    const { error: deleteError } = await supabase.from('persons').delete().eq('id', personId).eq('group_id', group.id)
    if (deleteError) return setError(deleteError.message)
    if (selectedPersonId === personId) setSelectedPersonId('')
    await fetchGroupData(group.id)
  }

  const renamePerson = async (personId: string, name: string) => {
    if (!group) return
    const clean = name.trim()
    if (!clean) return
    const { error: updateError } = await supabase
      .from('persons')
      .update({ name: clean })
      .eq('id', personId)
      .eq('group_id', group.id)
    if (updateError) return setError(updateError.message)
    await fetchGroupData(group.id)
  }

  const addTicks = async () => {
    if (!group || !selectedPerson || newTickCount < 1) return
    const { data: existing } = await supabase
      .from('transactions')
      .select('id,amount')
      .eq('group_id', group.id)
      .eq('person_id', selectedPerson.id)
      .eq('type', 'tick')
      .eq('event_date', tickDate)
      .maybeSingle()

    if (existing) {
      const { error: updateError } = await supabase
        .from('transactions')
        .update({ amount: existing.amount + newTickCount })
        .eq('id', existing.id)
      if (updateError) return setError(updateError.message)
    } else {
      const { error: insertError } = await supabase.from('transactions').insert({
        group_id: group.id,
        person_id: selectedPerson.id,
        type: 'tick',
        amount: newTickCount,
        event_date: tickDate,
      })
      if (insertError) return setError(insertError.message)
    }
    await fetchGroupData(group.id)
  }

  const addPayment = async () => {
    if (!group || !selectedPerson || paymentAmount <= 0) return
    const { error: insertError } = await supabase.from('transactions').insert({
      group_id: group.id,
      person_id: selectedPerson.id,
      type: 'payment',
      amount: Number(paymentAmount.toFixed(2)),
      event_date: tickDate,
    })
    if (insertError) return setError(insertError.message)
    addNotice(`${selectedPerson.name} heeft EUR ${paymentAmount.toFixed(2)} betaald`)
    setPaymentAmount(0)
    await fetchGroupData(group.id)
  }

  const saveEntryEdit = async (entry: Transaction) => {
    if (!group) return
    const draft = editing[entry.id]
    if (!draft) return
    const amount = draft.amount > 0 ? draft.amount : entry.amount
    const { error: updateError } = await supabase
      .from('transactions')
      .update({ amount, event_date: draft.date })
      .eq('id', entry.id)
      .eq('group_id', group.id)
    if (updateError) return setError(updateError.message)
    setEditing((previous) => {
      const next = { ...previous }
      delete next[entry.id]
      return next
    })
    await fetchGroupData(group.id)
  }

  const deleteEntry = async (entryId: string) => {
    if (!group) return
    const { error: deleteError } = await supabase.from('transactions').delete().eq('id', entryId).eq('group_id', group.id)
    if (deleteError) return setError(deleteError.message)
    await fetchGroupData(group.id)
  }

  const exportSheet = (mode: 'month' | 'year') => {
    const wb = XLSX.utils.book_new()
    const rows =
      mode === 'month'
        ? monthlyRows.map((row) => ({
            Maand: row.month,
            Streepjes: row.ticks,
            InEuro: (row.ticks * TICK_VALUE_EUR).toFixed(2),
            Betaald: row.payments.toFixed(2),
            Openstaand: row.debt.toFixed(2),
          }))
        : yearlyRows.map((row) => ({
            Jaar: row.year,
            Streepjes: row.ticks,
            InEuro: (row.ticks * TICK_VALUE_EUR).toFixed(2),
            Betaald: row.payments.toFixed(2),
            Openstaand: row.debt.toFixed(2),
          }))
    const ws = XLSX.utils.json_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, mode === 'month' ? 'Maandelijks' : 'Jaaroverzicht')
    XLSX.writeFile(wb, `bar-rapport-${mode}.xlsx`)
  }

  const envOk = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)

  if (!envOk) {
    return (
      <div className="app">
        <h1>Bar App</h1>
        <p>
          Voeg eerst <code>VITE_SUPABASE_URL</code> en <code>VITE_SUPABASE_ANON_KEY</code> toe aan <code>.env</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Scouting Bar Schuldbeheer</h1>
        <p>1 streepje = EUR {TICK_VALUE_EUR.toFixed(2)}</p>
        {group && (
          <div className="group-pill">
            <span>Groep: {group.name}</span>
            <span>Code: {group.code}</span>
          </div>
        )}
      </header>

      {!group && (
        <section className="card">
          <h2>Groep starten of joinen</h2>
          <form onSubmit={createGroup} className="stack">
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Groepsnaam" />
            <button disabled={loading} type="submit">
              Groep aanmaken
            </button>
          </form>
          <div className="join">
            <input
              value={groupCodeInput}
              onChange={(e) => setGroupCodeInput(e.target.value.toUpperCase())}
              placeholder="Unieke groepscode"
            />
            <button disabled={loading} onClick={() => void joinGroup()}>
              Join groep
            </button>
          </div>
        </section>
      )}

      {group && (
        <>
          {activeTab === 'personen' && (
            <section className="card">
              <h2>Personen (max 60)</h2>
              <form onSubmit={addPeopleBulk} className="stack">
                <textarea
                  value={bulkNames}
                  onChange={(e) => setBulkNames(e.target.value)}
                  rows={4}
                  placeholder="Voeg namen toe, 1 per regel of met komma's"
                />
                <button type="submit">Bulk toevoegen</button>
              </form>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Zoek persoon..." />
              <div className="list">
                {filteredBalances.map((person) => (
                  <button
                    key={person.id}
                    className={`list-item ${person.id === selectedPersonId ? 'active' : ''}`}
                    onClick={() => setSelectedPersonId(person.id)}
                  >
                    <strong>{person.name}</strong>
                    <span>Open: EUR {person.balance.toFixed(2)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {activeTab === 'invoer' && (
            <section className="card">
              <h2>Invoer</h2>
              {!selectedPerson && <p>Kies eerst een persoon in de tab Personen.</p>}
              {selectedPerson && (
                <div className="stack">
                  <div>
                    <input
                      defaultValue={selectedPerson.name}
                      onBlur={(e) => void renamePerson(selectedPerson.id, e.target.value)}
                    />
                    <button className="danger" onClick={() => void removePerson(selectedPerson.id)}>
                      Persoon verwijderen
                    </button>
                  </div>
                  <label>
                    Vrijdag datum (instelbaar):
                    <input type="date" value={tickDate} onChange={(e) => setTickDate(e.target.value)} />
                  </label>
                  <label>
                    Streepjes toevoegen:
                    <input
                      type="number"
                      min={1}
                      value={newTickCount}
                      onChange={(e) => setNewTickCount(Number(e.target.value))}
                    />
                  </label>
                  <button onClick={() => void addTicks()}>Streepjes bijtellen</button>
                  <label>
                    Bedrag betaald (EUR):
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={paymentAmount}
                      onChange={(e) => setPaymentAmount(Number(e.target.value))}
                    />
                  </label>
                  <button onClick={() => void addPayment()}>Als betaling registreren</button>
                </div>
              )}
            </section>
          )}

          {activeTab === 'historie' && (
            <section className="card">
              <h2>Historische invoer (aanpasbaar)</h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Naam</th>
                      <th>Type</th>
                      <th>Hoeveelheid</th>
                      <th>Datum</th>
                      <th>Acties</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((entry) => {
                      const person = persons.find((p) => p.id === entry.person_id)
                      const draft = editing[entry.id] ?? { amount: entry.amount, date: entry.event_date }
                      return (
                        <tr key={entry.id}>
                          <td>{person?.name ?? 'Onbekend'}</td>
                          <td>{entry.type === 'tick' ? 'Streepjes' : 'Betaling'}</td>
                          <td>
                            <input
                              type="number"
                              step={entry.type === 'tick' ? 1 : 0.01}
                              value={draft.amount}
                              onChange={(e) =>
                                setEditing((previous) => ({
                                  ...previous,
                                  [entry.id]: { ...draft, amount: Number(e.target.value) },
                                }))
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="date"
                              value={draft.date}
                              onChange={(e) =>
                                setEditing((previous) => ({
                                  ...previous,
                                  [entry.id]: { ...draft, date: e.target.value },
                                }))
                              }
                            />
                          </td>
                          <td>
                            <button onClick={() => void saveEntryEdit(entry)}>Opslaan</button>
                            <button className="danger" onClick={() => void deleteEntry(entry.id)}>
                              Verwijder
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === 'rapportage' && (
            <>
              <section className="grid">
                <article className="card">
                  <h2>Maandrapportage</h2>
                  {monthlyRows.map((row) => (
                    <p key={row.month}>
                      {row.month}: open EUR {row.debt.toFixed(2)}
                    </p>
                  ))}
                  <button onClick={() => exportSheet('month')}>Exporteer maand Excel</button>
                </article>
                <article className="card">
                  <h2>Jaaroverzicht</h2>
                  {yearlyRows.map((row) => (
                    <p key={row.year}>
                      {row.year}: open EUR {row.debt.toFixed(2)}
                    </p>
                  ))}
                  <button onClick={() => exportSheet('year')}>Exporteer jaar Excel</button>
                </article>
              </section>

              <section className="card">
                <h2>Negatieve saldo lijst (moet betalen)</h2>
                {personBalances
                  .filter((person) => person.balance > 0)
                  .map((person) => (
                    <p key={person.id}>
                      {person.name}: EUR {person.balance.toFixed(2)} ({person.ticks} streepjes)
                    </p>
                  ))}
              </section>
            </>
          )}

          {activeTab === 'instellingen' && (
            <section className="card">
              <h2>Instellingen</h2>
              <p>Groepsnaam: {group.name}</p>
              <p>Groepscode: {group.code}</p>
              <label>
                Standaard vrijdag datum:
                <input type="date" value={tickDate} onChange={(e) => setTickDate(e.target.value)} />
              </label>
              <button
                onClick={() => {
                  localStorage.removeItem(GROUP_STORAGE_KEY)
                  setGroup(null)
                  setPersons([])
                  setTransactions([])
                  setSelectedPersonId('')
                }}
              >
                Verlaat groep op dit toestel
              </button>
            </section>
          )}

          <nav className="tabbar">
            <button className={activeTab === 'personen' ? 'active' : ''} onClick={() => setActiveTab('personen')}>
              Personen
            </button>
            <button className={activeTab === 'invoer' ? 'active' : ''} onClick={() => setActiveTab('invoer')}>
              Invoer
            </button>
            <button className={activeTab === 'historie' ? 'active' : ''} onClick={() => setActiveTab('historie')}>
              Historie
            </button>
            <button className={activeTab === 'rapportage' ? 'active' : ''} onClick={() => setActiveTab('rapportage')}>
              Rapportage
            </button>
            <button
              className={activeTab === 'instellingen' ? 'active' : ''}
              onClick={() => setActiveTab('instellingen')}
            >
              Instellingen
            </button>
          </nav>
        </>
      )}

      {!!error && <p className="error">{error}</p>}
      <div className="notice-wrap">
        {notices.map((notice) => (
          <div key={notice.id} className="notice">
            {notice.message}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
