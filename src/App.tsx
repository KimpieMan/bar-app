import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import * as XLSX from 'xlsx'
import { format } from 'date-fns'
import { supabase } from './supabase'
import type { Group, Person, Transaction, WeeklyExpense } from './types'

const TICK_VALUE_EUR = 0.85
const GROUP_STORAGE_KEY = 'bar-app-group-code'
const FRIDAY_STORAGE_KEY = 'bar-app-last-friday'

type PersonBalance = Person & { ticks: number; payments: number; balance: number }
type Notice = { id: string; message: string }
type TabKey = 'personen' | 'invoer' | 'rapportage' | 'instellingen'
type DraftMode = 'plus' | 'minus'
type BulkDebtDraft = { id: string; name: string; eur: number; mode: DraftMode }
type ActionModal = {
  open: boolean
  type: 'tick' | 'payment'
  personId: string
  amount: number
  eventDate: string
}

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

const parseBulkDebtRows = (raw: string) =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let name = ''
      let amountRaw = ''

      if (line.includes('\t')) {
        const [first, ...rest] = line.split('\t')
        name = (first ?? '').trim()
        amountRaw = rest.join('\t').trim()
      } else if (line.includes(';')) {
        const [first, ...rest] = line.split(';')
        name = (first ?? '').trim()
        amountRaw = rest.join(';').trim()
      } else {
        // Comma-separated input: split only on first comma so decimal comma stays intact.
        const firstComma = line.indexOf(',')
        if (firstComma >= 0) {
          name = line.slice(0, firstComma).trim()
          amountRaw = line.slice(firstComma + 1).trim()
        } else {
          const parts = line.split(/\s+/)
          name = parts.slice(0, -1).join(' ').trim()
          amountRaw = parts.at(-1) ?? ''
        }
      }

      const eur = Number(amountRaw.replace(/\./g, '').replace(',', '.'))
      return { name, eur }
    })
    .filter((row) => row.name && Number.isFinite(row.eur) && row.eur !== 0)

function App() {
  const [groupCodeInput, setGroupCodeInput] = useState('')
  const [groupName, setGroupName] = useState('Scouting Bar')
  const [group, setGroup] = useState<Group | null>(null)
  const [persons, setPersons] = useState<Person[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [weeklyExpenses, setWeeklyExpenses] = useState<WeeklyExpense[]>([])
  const [search, setSearch] = useState('')
  const [expandedPersonId, setExpandedPersonId] = useState<string>('')
  const [bulkNames, setBulkNames] = useState('')
  const [bulkDebtRows, setBulkDebtRows] = useState('')
  const [bulkDebtDrafts, setBulkDebtDrafts] = useState<BulkDebtDraft[]>([])
  const [tickDate, setTickDate] = useState(localStorage.getItem(FRIDAY_STORAGE_KEY) ?? defaultFriday())
  const [actionModal, setActionModal] = useState<ActionModal>({
    open: false,
    type: 'tick',
    personId: '',
    amount: 1,
    eventDate: defaultFriday(),
  })
  const [notices, setNotices] = useState<Notice[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('personen')
  const [weeklyExpenseAmount, setWeeklyExpenseAmount] = useState<number>(0)
  const [weeklyExpenseDate, setWeeklyExpenseDate] = useState<string>(defaultFriday())
  const [weeklyExpenseNote, setWeeklyExpenseNote] = useState<string>('')

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
        return { ...person, ticks, payments, balance: ticks * TICK_VALUE_EUR - payments }
      })
      .sort((a, b) => b.balance - a.balance)
  }, [persons, transactions])

  const filteredBalances = useMemo(
    () => personBalances.filter((person) => person.name.toLowerCase().includes(search.toLowerCase().trim())),
    [personBalances, search],
  )

  const monthlyRows = useMemo(() => {
    const map = new Map<string, { ticks: number; payments: number; expenses: number }>()
    transactions.forEach((entry) => {
      const month = entry.event_date.slice(0, 7)
      const current = map.get(month) ?? { ticks: 0, payments: 0, expenses: 0 }
      if (entry.type === 'tick') current.ticks += entry.amount
      if (entry.type === 'payment') current.payments += entry.amount
      map.set(month, current)
    })
    weeklyExpenses.forEach((expense) => {
      const month = expense.event_date.slice(0, 7)
      const current = map.get(month) ?? { ticks: 0, payments: 0, expenses: 0 }
      current.expenses += expense.amount
      map.set(month, current)
    })
    return [...map.entries()]
      .map(([month, values]) => ({
        month,
        ticks: values.ticks,
        payments: values.payments,
        expenses: values.expenses,
        debt: values.ticks * TICK_VALUE_EUR + values.expenses - values.payments,
      }))
      .sort((a, b) => b.month.localeCompare(a.month))
  }, [transactions, weeklyExpenses])

  const yearlyRows = useMemo(() => {
    const map = new Map<string, { ticks: number; payments: number; expenses: number }>()
    transactions.forEach((entry) => {
      const year = entry.event_date.slice(0, 4)
      const current = map.get(year) ?? { ticks: 0, payments: 0, expenses: 0 }
      if (entry.type === 'tick') current.ticks += entry.amount
      if (entry.type === 'payment') current.payments += entry.amount
      map.set(year, current)
    })
    weeklyExpenses.forEach((expense) => {
      const year = expense.event_date.slice(0, 4)
      const current = map.get(year) ?? { ticks: 0, payments: 0, expenses: 0 }
      current.expenses += expense.amount
      map.set(year, current)
    })
    return [...map.entries()]
      .map(([year, values]) => ({
        year,
        ticks: values.ticks,
        payments: values.payments,
        expenses: values.expenses,
        debt: values.ticks * TICK_VALUE_EUR + values.expenses - values.payments,
      }))
      .sort((a, b) => b.year.localeCompare(a.year))
  }, [transactions, weeklyExpenses])

  const negativeBalancesText = useMemo(() => {
    return personBalances
      .filter((person) => person.balance < 0)
      .map((person) => `${person.name}: EUR ${Math.abs(person.balance).toFixed(2)}`)
      .join('\n')
  }, [personBalances])

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

    const expenseChannel = supabase
      .channel(`weekly-expenses-${group.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'weekly_expenses', filter: `group_id=eq.${group.id}` },
        () => {
          void fetchGroupData(group.id)
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(personsChannel)
      void supabase.removeChannel(txChannel)
      void supabase.removeChannel(expenseChannel)
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
    const [{ data: pData, error: pErr }, { data: tData, error: tErr }, { data: eData, error: eErr }] = await Promise.all([
      supabase.from('persons').select('*').eq('group_id', groupId).order('name'),
      supabase.from('transactions').select('*').eq('group_id', groupId).order('event_date', { ascending: false }),
      supabase.from('weekly_expenses').select('*').eq('group_id', groupId).order('event_date', { ascending: false }),
    ])
    if (pErr) return setError(pErr.message)
    if (tErr) return setError(tErr.message)
    if (eErr) return setError(eErr.message)
    setPersons((pData ?? []) as Person[])
    setTransactions((tData ?? []) as Transaction[])
    setWeeklyExpenses((eData ?? []) as WeeklyExpense[])
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

  const prepareDebtBulk = (e: FormEvent) => {
    e.preventDefault()
    const rows = parseBulkDebtRows(bulkDebtRows)
    if (!rows.length) return
    const drafts: BulkDebtDraft[] = rows.map((row, index) => ({
      id: `${Date.now()}-${index}`,
      name: row.name,
      eur: Math.abs(row.eur),
      mode: row.eur < 0 ? 'minus' : 'plus',
    }))
    setBulkDebtDrafts(drafts)
  }

  const applyDebtBulk = async () => {
    if (!group || !bulkDebtDrafts.length) return
    const rows = bulkDebtDrafts.filter((row) => row.name.trim() && row.eur > 0)
    if (!rows.length) return

    const personByName = new Map(persons.map((person) => [person.name.trim().toLowerCase(), person]))
    const pendingInserts: { group_id: string; name: string }[] = []

    rows.forEach((row) => {
      const key = row.name.trim().toLowerCase()
      if (!personByName.has(key)) {
        pendingInserts.push({ group_id: group.id, name: row.name.trim() })
        personByName.set(key, {
          id: '',
          group_id: group.id,
          name: row.name.trim(),
          created_at: new Date().toISOString(),
        })
      }
    })

    if (pendingInserts.length) {
      const { data: insertedPeople, error: insertPeopleError } = await supabase
        .from('persons')
        .insert(pendingInserts)
        .select('*')
      if (insertPeopleError) {
        setError(insertPeopleError.message)
        return
      }
      ;(insertedPeople ?? []).forEach((person) => {
        personByName.set(person.name.trim().toLowerCase(), person as Person)
      })
    }

    for (const row of rows) {
      const person = personByName.get(row.name.trim().toLowerCase())
      if (!person?.id) continue
      if (row.mode === 'plus') {
        const ticksToAdd = row.eur / TICK_VALUE_EUR
        const { data: existing } = await supabase
          .from('transactions')
          .select('id,amount')
          .eq('group_id', group.id)
          .eq('person_id', person.id)
          .eq('type', 'tick')
          .eq('event_date', tickDate)
          .maybeSingle()

        if (existing) {
          const { error: updateError } = await supabase
            .from('transactions')
            .update({ amount: existing.amount + ticksToAdd })
            .eq('id', existing.id)
          if (updateError) {
            setError(updateError.message)
            return
          }
        } else {
          const { error: insertError } = await supabase.from('transactions').insert({
            group_id: group.id,
            person_id: person.id,
            type: 'tick',
            amount: ticksToAdd,
            event_date: tickDate,
          })
          if (insertError) {
            setError(insertError.message)
            return
          }
        }
      } else {
        const { error: insertError } = await supabase.from('transactions').insert({
          group_id: group.id,
          person_id: person.id,
          type: 'payment',
          amount: row.eur,
          event_date: tickDate,
        })
        if (insertError) {
          setError(insertError.message)
          return
        }
      }
    }

    setBulkDebtRows('')
    setBulkDebtDrafts([])
    await fetchGroupData(group.id)
    addNotice(`Bulk schuldimport verwerkt (${rows.length} regels)`)
  }

  const removePerson = async (personId: string) => {
    if (!group) return
    await supabase.from('transactions').delete().eq('person_id', personId).eq('group_id', group.id)
    const { error: deleteError } = await supabase.from('persons').delete().eq('id', personId).eq('group_id', group.id)
    if (deleteError) return setError(deleteError.message)
    if (expandedPersonId === personId) setExpandedPersonId('')
    await fetchGroupData(group.id)
  }

  const addTicksForPerson = async (personId: string, tickCount: number, eventDate: string) => {
    if (!group || tickCount <= 0) return
    const { data: existing } = await supabase
      .from('transactions')
      .select('id,amount')
      .eq('group_id', group.id)
      .eq('person_id', personId)
      .eq('type', 'tick')
      .eq('event_date', eventDate)
      .maybeSingle()

    if (existing) {
      const { error: updateError } = await supabase
        .from('transactions')
        .update({ amount: existing.amount + tickCount })
        .eq('id', existing.id)
      if (updateError) return setError(updateError.message)
    } else {
      const { error: insertError } = await supabase.from('transactions').insert({
        group_id: group.id,
        person_id: personId,
        type: 'tick',
        amount: tickCount,
        event_date: eventDate,
      })
      if (insertError) return setError(insertError.message)
    }
    await fetchGroupData(group.id)
  }

  const addPaymentForPerson = async (personId: string, amount: number, eventDate: string) => {
    if (!group || amount <= 0) return
    const { error: insertError } = await supabase.from('transactions').insert({
      group_id: group.id,
      person_id: personId,
      type: 'payment',
      amount,
      event_date: eventDate,
    })
    if (insertError) return setError(insertError.message)
    const personName = persons.find((person) => person.id === personId)?.name ?? 'Persoon'
    addNotice(`${personName} heeft EUR ${amount} betaald`)
    await fetchGroupData(group.id)
  }

  const openActionModal = (personId: string, type: 'tick' | 'payment') => {
    setActionModal({
      open: true,
      type,
      personId,
      amount: type === 'tick' ? 1 : 0,
      eventDate: tickDate || defaultFriday(),
    })
  }

  const confirmActionModal = async () => {
    if (!actionModal.personId || !actionModal.eventDate) return
    if (actionModal.type === 'tick') {
      await addTicksForPerson(actionModal.personId, actionModal.amount, actionModal.eventDate)
    } else {
      await addPaymentForPerson(actionModal.personId, actionModal.amount, actionModal.eventDate)
    }
    setActionModal((prev) => ({ ...prev, open: false }))
  }

  const addWeeklyExpense = async () => {
    if (!group || weeklyExpenseAmount <= 0 || !weeklyExpenseDate) return
    const { error: insertError } = await supabase.from('weekly_expenses').insert({
      group_id: group.id,
      amount: weeklyExpenseAmount,
      event_date: weeklyExpenseDate,
      note: weeklyExpenseNote.trim() || null,
    })
    if (insertError) return setError(insertError.message)
    setWeeklyExpenseAmount(0)
    setWeeklyExpenseNote('')
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
            Uitgaven: row.expenses.toFixed(2),
            Betaald: row.payments.toFixed(2),
            Openstaand: row.debt.toFixed(2),
          }))
        : yearlyRows.map((row) => ({
            Jaar: row.year,
            Streepjes: row.ticks,
            InEuro: (row.ticks * TICK_VALUE_EUR).toFixed(2),
            Uitgaven: row.expenses.toFixed(2),
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
              <div className="list">
                {filteredBalances.map((person) => (
                  <div key={person.id} className="person-row">
                    <div>
                      <strong>{person.name}</strong>
                    </div>
                    <button className="danger" onClick={() => void removePerson(person.id)}>
                      Verwijder
                    </button>
                  </div>
                ))}
              </div>
              <form onSubmit={prepareDebtBulk} className="stack">
                <h3>Bulk schuld toevoegen (Excel)</h3>
                <p>Plak regels als: Naam, bedrag_in_euro (ook ; of tab is goed)</p>
                <textarea
                  value={bulkDebtRows}
                  onChange={(e) => setBulkDebtRows(e.target.value)}
                  rows={5}
                  placeholder={'Jayden, 12.75\nNoah; -8,50\nEmma\t4.25'}
                />
                <button type="submit">Voorbeeld tonen</button>
              </form>

              {!!bulkDebtDrafts.length && (
                <div className="stack">
                  <h3>Bevestigen en corrigeren</h3>
                  <p>Controleer per regel naam, bedrag en plus/min saldo voordat je importeert.</p>
                  <div className="import-grid">
                    <div className="import-head">Naam</div>
                    <div className="import-head">Bedrag (EUR)</div>
                    <div className="import-head">Saldo</div>
                    <div className="import-head">Actie</div>
                    {bulkDebtDrafts.map((row) => (
                      <div className="import-row" key={row.id}>
                        <input
                          value={row.name}
                          onChange={(e) =>
                            setBulkDebtDrafts((prev) =>
                              prev.map((item) => (item.id === row.id ? { ...item, name: e.target.value } : item)),
                            )
                          }
                        />
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={row.eur}
                          onChange={(e) =>
                            setBulkDebtDrafts((prev) =>
                              prev.map((item) =>
                                item.id === row.id ? { ...item, eur: Number(e.target.value) || 0 } : item,
                              ),
                            )
                          }
                        />
                        <select
                          value={row.mode}
                          onChange={(e) =>
                            setBulkDebtDrafts((prev) =>
                              prev.map((item) =>
                                item.id === row.id ? { ...item, mode: e.target.value as DraftMode } : item,
                              ),
                            )
                          }
                        >
                          <option value="plus">Plus (schuld omhoog)</option>
                          <option value="minus">Min (betaling/tegoed)</option>
                        </select>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => setBulkDebtDrafts((prev) => prev.filter((item) => item.id !== row.id))}
                        >
                          Verwijder
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="import-actions">
                    <button type="button" onClick={() => setBulkDebtDrafts([])}>
                      Annuleren
                    </button>
                    <button type="button" onClick={() => void applyDebtBulk()}>
                      Bevestigen en importeren
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {activeTab === 'invoer' && (
            <section className="card">
              <h2>Invoer</h2>
              <p>Klik op een persoon om acties open te klappen.</p>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Zoek persoon..." />
              <div className="list">
                {filteredBalances.map((person) => (
                  <div key={person.id} className="accordion-item">
                    <button
                      className={`list-item ${expandedPersonId === person.id ? 'active' : ''}`}
                      onClick={() => setExpandedPersonId((prev) => (prev === person.id ? '' : person.id))}
                    >
                      <strong>{person.name}</strong>
                      <span>Open: EUR {Math.abs(person.balance).toFixed(2)}</span>
                    </button>
                    {expandedPersonId === person.id && (
                      <div className="accordion-body">
                        <p>Saldo: EUR {person.balance.toFixed(2)}</p>
                        <div className="import-actions">
                          <button type="button" onClick={() => openActionModal(person.id, 'tick')}>
                            Streepjes toevoegen
                          </button>
                          <button type="button" onClick={() => openActionModal(person.id, 'payment')}>
                            Betaling registreren
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
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
                      {row.month}: open EUR {row.debt.toFixed(2)} (uitgaven EUR {row.expenses.toFixed(2)})
                    </p>
                  ))}
                  <button onClick={() => exportSheet('month')}>Exporteer maand Excel</button>
                </article>
                <article className="card">
                  <h2>Jaaroverzicht</h2>
                  {yearlyRows.map((row) => (
                    <p key={row.year}>
                      {row.year}: open EUR {row.debt.toFixed(2)} (uitgaven EUR {row.expenses.toFixed(2)})
                    </p>
                  ))}
                  <button onClick={() => exportSheet('year')}>Exporteer jaar Excel</button>
                </article>
              </section>

              <section className="card">
                <h2>Wekelijkse uitgaven consumpties</h2>
                <div className="stack">
                  <label>
                    Bedrag (EUR)
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={weeklyExpenseAmount}
                      onChange={(e) => setWeeklyExpenseAmount(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Datum (week)
                    <input
                      type="date"
                      value={weeklyExpenseDate}
                      onChange={(e) => setWeeklyExpenseDate(e.target.value)}
                    />
                  </label>
                  <label>
                    Opmerking (optioneel)
                    <input
                      value={weeklyExpenseNote}
                      onChange={(e) => setWeeklyExpenseNote(e.target.value)}
                      placeholder="Bijv. inkoop frisdrank"
                    />
                  </label>
                  <button onClick={() => void addWeeklyExpense()}>Uitgave toevoegen</button>
                </div>
                <div className="stack">
                  {weeklyExpenses.slice(0, 12).map((expense) => (
                    <p key={expense.id}>
                      {expense.event_date}: EUR {expense.amount.toFixed(2)}
                      {expense.note ? ` - ${expense.note}` : ''}
                    </p>
                  ))}
                </div>
              </section>

              <section className="card">
                <h2>Negatieve saldo lijst (moet betalen)</h2>
                {personBalances
                  .filter((person) => person.balance < 0)
                  .map((person) => (
                    <p key={person.id}>
                      {person.name}: EUR {Math.abs(person.balance).toFixed(2)}
                    </p>
                  ))}
                <label>
                  Kopieerlijst voor doorsturen
                  <textarea readOnly rows={8} value={negativeBalancesText} />
                </label>
                <button
                  onClick={async () => {
                    if (!negativeBalancesText.trim()) return
                    await navigator.clipboard.writeText(negativeBalancesText)
                    addNotice('Lijst gekopieerd')
                  }}
                >
                  Kopieer lijst
                </button>
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
                  setExpandedPersonId('')
                }}
              >
                Verlaat groep op dit toestel
              </button>
            </section>
          )}

          <nav className="tabbar">
            <button className={activeTab === 'personen' ? 'active' : ''} onClick={() => setActiveTab('personen')}>
              <span className="tab-icon">👥</span>
              <span className="tab-label">Personen</span>
            </button>
            <button className={activeTab === 'invoer' ? 'active' : ''} onClick={() => setActiveTab('invoer')}>
              <span className="tab-icon">➕</span>
              <span className="tab-label">Invoer</span>
            </button>
            <button className={activeTab === 'rapportage' ? 'active' : ''} onClick={() => setActiveTab('rapportage')}>
              <span className="tab-icon">📊</span>
              <span className="tab-label">Rapportage</span>
            </button>
            <button
              className={activeTab === 'instellingen' ? 'active' : ''}
              onClick={() => setActiveTab('instellingen')}
            >
              <span className="tab-icon">⚙️</span>
              <span className="tab-label">Instellingen</span>
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
      {actionModal.open && (
        <div className="modal-backdrop" onClick={() => setActionModal((prev) => ({ ...prev, open: false }))}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>{actionModal.type === 'tick' ? 'Streepjes toevoegen' : 'Betaling registreren'}</h3>
            <label>
              {actionModal.type === 'tick' ? 'Aantal streepjes' : 'Bedrag betaald (EUR)'}
              <input
                type="number"
                min={0}
                step={actionModal.type === 'tick' ? 1 : 0.01}
                value={actionModal.amount}
                onChange={(e) => setActionModal((prev) => ({ ...prev, amount: Number(e.target.value) }))}
              />
            </label>
            <label>
              Datum
              <input
                type="date"
                value={actionModal.eventDate}
                onChange={(e) => setActionModal((prev) => ({ ...prev, eventDate: e.target.value }))}
              />
            </label>
            <div className="import-actions">
              <button type="button" onClick={() => setActionModal((prev) => ({ ...prev, open: false }))}>
                Annuleren
              </button>
              <button type="button" onClick={() => void confirmActionModal()}>
                Opslaan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
