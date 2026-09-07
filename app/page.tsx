"use client"

import { useActiveSection } from "@/components/sections/active-section-context"
import { SectionShell } from "@/components/sections/section-shell"
import { Sidebar } from "@/components/sidebar"

export default function Page() {
  const { active, setActive } = useActiveSection()

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <Sidebar active={active} onChange={setActive} />
      <SectionShell active={active} />
    </div>
  )
}
