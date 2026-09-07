"use client"

import * as React from "react"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

type SettingsPanelProps = {
  title: string
  description: string
  children: React.ReactNode
  /**
   * Something to act on the whole section, sat beside its heading.
   *
   * Optional, and most sections have nothing to put here - a section made of
   * settings is acted on by changing the settings. It exists for the ones with
   * a verb attached to the screen itself, like running an update check.
   */
  actions?: React.ReactNode
  className?: string
  /** Drops the `space-y` between children, for a section laying itself out. */
  bare?: boolean
}

export function SettingsPanel({
  title,
  description,
  children,
  actions,
  className,
  bare,
}: SettingsPanelProps) {
  return (
    <section className={cn("min-w-0", className)}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-3">{actions}</div>
        ) : null}
      </header>
      <div className={cn(!bare && "space-y-2")}>{children}</div>
    </section>
  )
}

type SettingsFieldRowProps = {
  label: string
  description?: string
  children: React.ReactNode
  disabled?: boolean
}

export function SettingsFieldRow({
  label,
  description,
  children,
  disabled,
}: SettingsFieldRowProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between",
        disabled && "pointer-events-none opacity-50"
      )}
      aria-disabled={disabled}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">{label}</div>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

type SettingsToggleProps = {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  label: string
  disabled?: boolean
}

export function SettingsToggle({
  checked,
  onCheckedChange,
  label,
  disabled,
}: SettingsToggleProps) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
    />
  )
}

type SettingsTextFieldProps = {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

export function SettingsTextField({
  value,
  onValueChange,
  placeholder,
  disabled,
}: SettingsTextFieldProps) {
  return (
    <Input
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      placeholder={placeholder}
      className="w-56"
      disabled={disabled}
    />
  )
}

type SettingsSelectFieldProps = {
  value: string
  onValueChange: (value: string) => void
  options: Array<{ label: string; value: string }>
  disabled?: boolean
}

export function SettingsSelectField({
  value,
  onValueChange,
  options,
  disabled,
}: SettingsSelectFieldProps) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) {
          onValueChange(next)
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-56">
        {/* Base UI's `Select.Value` renders the selected *value*, so left to
            itself the trigger showed a raw "system" while the open list showed
            "System" directly beside it. The label is looked up here, the same
            way the configure panel does it. */}
        <SelectValue placeholder="Select option">
          {options.find((option) => option.value === value)?.label ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type SettingsSliderFieldProps = {
  value: number
  onValueChange: (value: number) => void
  formatValue?: (value: number) => React.ReactNode
  min?: number
  max?: number
  step?: number
  disabled?: boolean
}

export function SettingsSliderField({
  value,
  onValueChange,
  formatValue,
  min = 0,
  max = 100,
  step = 1,
  disabled,
}: SettingsSliderFieldProps) {
  return (
    <div className="flex w-full items-center gap-3 sm:w-72">
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        // Base UI hands back a bare number for a single-thumb slider and an
        // array only when there are several.
        onValueChange={(next) =>
          onValueChange(Array.isArray(next) ? (next[0] ?? value) : next)
        }
      />
      <span className="w-16 shrink-0 text-right text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
        {formatValue ? formatValue(value) : value}
      </span>
    </div>
  )
}
