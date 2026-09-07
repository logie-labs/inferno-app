"use client"

import { RiSearchLine } from "@remixicon/react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type SearchFormProps = {
  value: string
  onValueChange: (value: string) => void
}

export function SearchForm({ value, onValueChange }: SearchFormProps) {
  return (
    <form onSubmit={(event) => event.preventDefault()} className="relative">
      <Label htmlFor="search-settings" className="sr-only">
        Search settings
      </Label>
      <Input
        id="search-settings"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder="Search settings..."
        className="pl-8"
      />
      <RiSearchLine className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 opacity-50 select-none" />
    </form>
  )
}
