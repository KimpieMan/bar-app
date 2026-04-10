export type Group = {
  id: string
  code: string
  name: string
  created_at: string
}

export type Person = {
  id: string
  group_id: string
  name: string
  created_at: string
}

export type Transaction = {
  id: string
  group_id: string
  person_id: string
  type: 'tick' | 'payment'
  amount: number
  event_date: string
  created_at: string
}

export type WeeklyExpense = {
  id: string
  group_id: string
  amount: number
  event_date: string
  note: string | null
  created_at: string
}
