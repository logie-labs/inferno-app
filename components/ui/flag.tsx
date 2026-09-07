"use client"

// Named exports only, one per country - so the whole namespace is imported
// to be able to look one up by a code decided at runtime.
import * as Flags from "country-flag-icons/react/3x2"

import { cn } from "@/lib/utils"

/**
 * The country whose flag stands in for a language tag.
 *
 * A caption track is tagged with a *language* (`en`, `pt-BR`), not a country,
 * and the two genuinely do not map one to one - which is why this UI showed
 * language names alone before. `Intl.Locale.maximize()` is the principled way
 * to bridge them: it applies CLDR's likely-subtags data, so `en` becomes `US`
 * and `ja` becomes `JP` by the same table every other piece of software uses,
 * rather than by a list somebody here made up.
 *
 * It is still a *likely* region and not a fact about the track, so the flag is
 * only ever shown beside the language's name, never instead of it.
 *
 * Returns null when there is nothing sensible to draw: `es-419` maximises to
 * the UN code for Latin America, which is a real region with no flag, and an
 * unrecognised tag maximises to nothing at all.
 */
export function flagFor(languageCode: string): string | null {
  let region: string | undefined

  try {
    region = new Intl.Locale(languageCode).maximize().region
  } catch {
    return null
  }

  // Two letters is an ISO country; three digits is a UN M49 area, which has no
  // flag of its own.
  if (!region || !/^[A-Z]{2}$/.test(region)) {
    return null
  }

  return region in Flags ? region : null
}

/**
 * A flag for a language tag, or nothing.
 *
 * Renders nothing rather than a placeholder box: a missing flag should leave
 * the language's name sitting where it would have been anyway, not a grey
 * square implying something failed to load.
 */
export function LanguageFlag({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  const country = flagFor(code)
  if (!country) {
    return null
  }

  const Flag = Flags[country as keyof typeof Flags]

  return (
    <Flag
      // Decorative: the language name beside it is the real label, and a
      // screen reader announcing "United States" for an English track would be
      // actively misleading.
      aria-hidden
      className={cn(
        "h-2.5 w-3.5 shrink-0 rounded-[1px] shadow-[0_0_0_1px_color-mix(in_oklab,var(--foreground)_15%,transparent)]",
        className
      )}
    />
  )
}
