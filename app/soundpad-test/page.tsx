"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { soundpadErrorMessage, type SoundpadError } from "@/lib/soundpad"

import { groups, testCases, type FieldSpec, type FieldValues, type TestCase } from "./test-cases"

type RowState = {
  status: "idle" | "running" | "ok" | "error"
  result?: string
  error?: string
  isNotLaunched?: boolean
}

function isSoundpadError(value: unknown): value is SoundpadError {
  return typeof value === "object" && value !== null && "kind" in value
}

function defaultFieldValues(fields?: FieldSpec[]): FieldValues {
  const values: FieldValues = {}
  for (const field of fields ?? []) {
    values[field.name] = field.defaultValue
  }
  return values
}

export default function SoundpadTestPage() {
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [fieldValues, setFieldValues] = useState<Record<string, FieldValues>>(() => {
    const initial: Record<string, FieldValues> = {}
    for (const testCase of testCases) {
      initial[testCase.id] = defaultFieldValues(testCase.fields)
    }
    return initial
  })
  const [runningAll, setRunningAll] = useState(false)

  const setField = (caseId: string, fieldName: string, value: FieldValues[string]) => {
    setFieldValues((prev) => ({
      ...prev,
      [caseId]: { ...prev[caseId], [fieldName]: value },
    }))
  }

  const runCase = async (testCase: TestCase) => {
    setRows((prev) => ({ ...prev, [testCase.id]: { status: "running" } }))
    try {
      const result = await testCase.run(fieldValues[testCase.id] ?? {})
      setRows((prev) => ({
        ...prev,
        [testCase.id]: { status: "ok", result: JSON.stringify(result) },
      }))
    } catch (err) {
      if (isSoundpadError(err)) {
        setRows((prev) => ({
          ...prev,
          [testCase.id]: {
            status: "error",
            error: soundpadErrorMessage(err),
            isNotLaunched: err.kind === "NotLaunched",
          },
        }))
      } else {
        setRows((prev) => ({
          ...prev,
          [testCase.id]: { status: "error", error: String(err) },
        }))
      }
    }
  }

  const runAllSafeChecks = async () => {
    setRunningAll(true)
    for (const testCase of testCases.filter((c) => c.autoRun)) {
      await runCase(testCase)
    }
    setRunningAll(false)
  }

  const autoRunCount = testCases.filter((c) => c.autoRun).length

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 text-sm">
      <div className="flex flex-col gap-1">
        <h1 className="font-medium">Soundpad addon test harness</h1>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Drives every soundpad Tauri command against a live Soundpad instance. If Soundpad
          isn&apos;t running, the read-only checks below should each fail with{" "}
          <code className="text-foreground">NotLaunched</code> - that&apos;s the error path
          working correctly, not a bug. The rest are manual triggers only (they play audio or
          mutate the library), so they&apos;re excluded from &quot;run all&quot;.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={runAllSafeChecks} disabled={runningAll}>
          {runningAll ? "Running..." : `Run all read-only checks (${autoRunCount})`}
        </Button>
      </div>

      {groups.map((group) => (
        <section key={group} className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {group}
          </h2>
          <div className="divide-border border-border flex flex-col divide-y rounded-md border">
            {testCases
              .filter((c) => c.group === group)
              .map((testCase) => {
                const row = rows[testCase.id]
                return (
                  <div key={testCase.id} className="flex flex-col gap-2 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{testCase.label}</span>
                        {testCase.autoRun && (
                          <span className="text-muted-foreground text-[0.625rem]">
                            read-only
                          </span>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => runCase(testCase)}
                        disabled={row?.status === "running"}
                      >
                        {row?.status === "running" ? "Running..." : "Run"}
                      </Button>
                    </div>

                    {testCase.fields && testCase.fields.length > 0 && (
                      <div className="flex flex-wrap gap-3">
                        {testCase.fields.map((field) => (
                          <label
                            key={field.name}
                            className="text-muted-foreground flex items-center gap-1 text-xs"
                          >
                            {field.label}
                            {field.type === "boolean" ? (
                              <input
                                type="checkbox"
                                checked={Boolean(fieldValues[testCase.id]?.[field.name])}
                                onChange={(e) =>
                                  setField(testCase.id, field.name, e.target.checked)
                                }
                              />
                            ) : field.type === "text" ? (
                              <input
                                type="text"
                                className="border-border bg-input/30 w-40 rounded-sm border px-1.5 py-0.5 text-xs"
                                value={String(fieldValues[testCase.id]?.[field.name] ?? "")}
                                onChange={(e) =>
                                  setField(testCase.id, field.name, e.target.value)
                                }
                              />
                            ) : (
                              <input
                                type="number"
                                className="border-border bg-input/30 w-20 rounded-sm border px-1.5 py-0.5 text-xs"
                                value={String(fieldValues[testCase.id]?.[field.name] ?? "")}
                                onChange={(e) =>
                                  setField(testCase.id, field.name, e.target.value)
                                }
                              />
                            )}
                          </label>
                        ))}
                      </div>
                    )}

                    {row && row.status !== "idle" && row.status !== "running" && (
                      <div
                        className={
                          row.status === "ok"
                            ? "text-xs text-emerald-600 dark:text-emerald-400"
                            : row.isNotLaunched
                              ? "text-muted-foreground text-xs"
                              : "text-destructive text-xs"
                        }
                      >
                        {row.status === "ok" ? `Result: ${row.result}` : `Error: ${row.error}`}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        </section>
      ))}
    </div>
  )
}
