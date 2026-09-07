import { Geist_Mono, Manrope } from "next/font/google"

import "./globals.css"
import { CommandPalette } from "@/components/command-palette"
import { ContextMenuGuard } from "@/components/context-menu-guard"
import { SpotifyConflictDialog } from "@/components/spotify-conflict-dialog"
import { ActiveSectionProvider } from "@/components/sections/active-section-context"
import { InfernoServiceProvider } from "@/components/sections/downloads/service-context"
import { ThemeProvider } from "@/components/theme-provider"
import { UpdateWatcher } from "@/components/update-watcher"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WindowToolbar } from "@/components/window-toolbar"
import { cn } from "@/lib/utils"

const manrope = Manrope({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        manrope.variable
      )}
    >
      <body className="grid h-svh grid-rows-[auto_1fr] overflow-hidden">
        <ThemeProvider>
          <TooltipProvider>
            {/* Above the sections: a download keeps running while you are
                on another screen, and returning to the queue should show what
                is there rather than reconnecting and rebuilding it. */}
            <InfernoServiceProvider>
              <ActiveSectionProvider>
                <WindowToolbar />
                <main className="min-h-0 overflow-auto">{children}</main>
                {/* Inside the section provider: navigating is most of what the
                  palette does, and its shortcut listener has to be alive on
                  every screen, not only the one that mounted it. */}
                <CommandPalette />
                {/* Also inside the section provider: finding an update offers
                    to take you to the screen that explains it, and it has to
                    be able to do that from wherever you were. */}
                <UpdateWatcher />
                <ContextMenuGuard />
                {/* At the root: a download finishing asks this question
                    from the service provider, which is not on any one
                    screen. */}
                <SpotifyConflictDialog />
              </ActiveSectionProvider>
            </InfernoServiceProvider>
          </TooltipProvider>
          <Toaster position="bottom-center" />
        </ThemeProvider>
      </body>
    </html>
  )
}
