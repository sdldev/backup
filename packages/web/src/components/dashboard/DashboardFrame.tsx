import type { ReactNode } from "react"
import packageJson from "../../../package.json" with { type: "json" }
import type { DashboardNavGroup, DashboardNavItem } from "src/lib/dashboard-nav"
import { ThemeToggle } from "src/components/theme/ThemeToggle"
import { Avatar, AvatarFallback } from "src/components/ui/avatar"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "src/components/ui/alert-dialog"
import { Button } from "src/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "src/components/ui/dropdown-menu"
import { Separator } from "src/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "src/components/ui/sidebar"

function getIcon(label: string) {
  const key = label.toLowerCase()

  if (key.includes("workspace")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 8h10" />
        <path d="M7 12h4" />
      </svg>
    )
  }

  if (key.includes("project")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
      </svg>
    )
  }

  if (key.includes("backup")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v10" />
        <path d="m8 9 4 4 4-4" />
        <path d="M5 17a7 7 0 0 0 14 0" />
      </svg>
    )
  }

  if (key.includes("member")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    )
  }

  if (key.includes("audit")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    )
  }

  if (key.includes("new")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
    )
  }

  if (key.includes("onboarding")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 11 3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 11 12 3l9 8" />
      <path d="M5 10v10h14V10" />
    </svg>
  )
}

const APP_VERSION = packageJson.version
const LAST_UPDATED = "2026-05-08"

function DashboardFrame({
  brandLabel,
  brandName,
  navItems = [],
  navGroups,
  sidebarNote,
  pageTitle = "Dashboard",
  children,
}: {
  brandLabel: string
  brandName: string
  navItems?: DashboardNavItem[]
  navGroups?: DashboardNavGroup[]
  sidebarNote: string
  pageTitle?: string
  children?: ReactNode
}) {
  const groups = navGroups ?? [{ id: "dashboard", label: "Dashboard", items: navItems }]

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" className="dashboard-sidebar-surface border-r border-sidebar-border bg-sidebar">
        <SidebarHeader className="h-14 border-b border-sidebar-border/70 px-2.5 py-1.5">
          <a href="/app" className="group/brand flex h-full items-center gap-3 rounded-xl px-2 text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
            <span className="relative flex size-8 shrink-0 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-sm ring-1 ring-sidebar-ring/10" aria-hidden="true">
              <span className="size-3 rotate-45 rounded-sm border border-current/40 bg-current/15" />

            </span>
            <span className="min-w-0 group-data-[collapsible=icon]:hidden">
              <span className="block truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/65">{brandLabel}</span>
              <span className="block truncate text-sm font-semibold leading-5">{brandName}</span>
            </span>
          </a>
        </SidebarHeader>

        <SidebarContent className="px-2.5 py-3">
          {groups.map((group) => (
            <SidebarGroup key={group.id} className="p-0 pb-4">
              <SidebarGroupLabel className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/60">{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-1">
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={item.active}
                        tooltip={item.label}
                        className="relative h-9 rounded-lg px-2.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-primary/10 data-[active=true]:text-sidebar-accent-foreground data-[active=true]:before:absolute data-[active=true]:before:left-0 data-[active=true]:before:top-2 data-[active=true]:before:h-5 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-full data-[active=true]:before:bg-primary group-data-[collapsible=icon]:!size-9 group-data-[collapsible=icon]:!p-0"
                      >
                        <a href={item.href} className="justify-start group-data-[collapsible=icon]:justify-center">
                          <span className="grid size-4 shrink-0 place-items-center text-sidebar-foreground/55 group-data-[active=true]/menu-button:text-primary [&>svg]:size-4">{getIcon(item.label)}</span>
                          <span className="truncate text-[13px] font-medium group-data-[collapsible=icon]:hidden">{item.label}</span>

                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border/70 p-2.5">
          {sidebarNote ? <p className="rounded-xl border border-sidebar-border/80 bg-sidebar-accent/35 p-2.5 text-[11px] leading-5 text-sidebar-foreground/65 shadow-sm group-data-[collapsible=icon]:hidden">{sidebarNote}</p> : null}
          <p className="hidden px-1 text-[10px] leading-4 text-sidebar-foreground/55 md:block group-data-[collapsible=icon]:hidden">
            Version v{APP_VERSION} · <time dateTime={LAST_UPDATED}>Updated {LAST_UPDATED}</time>
          </p>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="dashboard-surface min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-background/88 px-4 backdrop-blur-xl md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="h-4" />
            <h1 className="truncate text-lg font-semibold tracking-tight md:text-xl">{pageTitle}</h1>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" type="button" aria-label="Toggle fullscreen" className="text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={async () => {
              if (!document.fullscreenElement) {
                await document.documentElement.requestFullscreen?.()
                return
              }
              await document.exitFullscreen?.()
            }}>
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
              <span className="sr-only">Toggle fullscreen</span>
            </Button>
            <Button variant="ghost" size="icon" type="button" aria-label="Notifications" className="relative text-muted-foreground hover:bg-accent hover:text-accent-foreground">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span className="absolute right-2 top-2 size-2 rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--background))]" aria-hidden="true" />
              <span className="sr-only">Notifications</span>
            </Button>
            <ThemeToggle />
            <AlertDialog>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground" aria-label="User account">
                    <Avatar className="size-7"><AvatarFallback>PO</AvatarFallback></Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel>Portal Online</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <AlertDialogTrigger asChild>
                    <DropdownMenuItem onSelect={(event) => event.preventDefault()}>Logout</DropdownMenuItem>
                  </AlertDialogTrigger>
                </DropdownMenuContent>
              </DropdownMenu>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Logout dari Portal?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Sesi aktif akan diakhiri. Setelah logout, kamu akan diarahkan ke halaman login.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Batal</AlertDialogCancel>
                  <AlertDialogAction data-logout>Logout</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </header>
        <main className="w-full p-4 md:p-6 lg:p-7">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default DashboardFrame
