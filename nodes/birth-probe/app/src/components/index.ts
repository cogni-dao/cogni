// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components`
 * Purpose: Public surface for components module via re-exports of shared UI components.
 * Scope: Re-exports components only. Does not export internal utilities or development helpers.
 * Invariants: Only re-exports from component files; no circular dependencies; maintains type exports.
 * Side-effects: none
 * Notes: Changes here affect components public API contract; follows barrel export pattern.
 * Links: ARCHITECTURE.md#public-surface
 * @public
 */

export { Checkbox } from "@cogni/node-ui-kit/shadcn/checkbox";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@cogni/node-ui-kit/shadcn/dialog";
export {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cogni/node-ui-kit/shadcn/popover";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@cogni/node-ui-kit/shadcn/select";
export { Separator } from "@cogni/node-ui-kit/shadcn/separator";
export {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@cogni/node-ui-kit/shadcn/sheet";
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@cogni/node-ui-kit/shadcn/sidebar";
export { Skeleton } from "@cogni/node-ui-kit/shadcn/skeleton";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@cogni/node-ui-kit/shadcn/table";
export {
  ToggleGroup,
  ToggleGroupItem,
} from "@cogni/node-ui-kit/shadcn/toggle-group";
export {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cogni/node-ui-kit/shadcn/tooltip";
export {
  chatContainer,
  chatDivider,
  chatForm,
  chatMessage,
  chatMessages,
  container,
  grid,
  heroButtons,
  heroText,
  heroVisual,
  section,
} from "@/styles/ui";
export { Reveal } from "./kit/animation/Reveal";
export { SignInDialog } from "./kit/auth/SignInDialog";
export { WalletConnectButton } from "./kit/auth/WalletConnectButton";
export * from "./kit/chat";
export { Avatar, AvatarFallback, AvatarImage } from "./kit/data-display/Avatar";
export { Badge } from "./kit/data-display/Badge";
export { ExpandableTableRow } from "./kit/data-display/ExpandableTableRow";
export { GithubButton } from "./kit/data-display/GithubButton";
export {
  PieChart,
  type PieChartDatum,
} from "./kit/data-display/PieChart";
export type { ProviderIconProps } from "./kit/data-display/ProviderIcons";
export {
  DiscordIcon,
  EthereumIcon,
  GitHubIcon,
  GoogleIcon,
} from "./kit/data-display/ProviderIcons";
export { TerminalFrame } from "./kit/data-display/TerminalFrame";
export { Alert, AlertDescription, AlertTitle } from "./kit/feedback/Alert";
export {
  ErrorAlert,
  type ErrorAlertProps,
  type ErrorAlertRef,
} from "./kit/feedback/ErrorAlert";
export { HintText } from "./kit/feedback/HintText";
export { Progress } from "./kit/feedback/Progress";
export { Button } from "./kit/inputs/Button";
export { Input } from "./kit/inputs/Input";
export { ModeToggle } from "./kit/inputs/ModeToggle";
export { SplitInput } from "./kit/inputs/SplitInput";
export {
  type TimeRange,
  TimeRangeSelector,
} from "./kit/inputs/TimeRangeSelector";
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./kit/layout/Card";
export { Container } from "./kit/layout/Container";
export { PageContainer } from "./kit/layout/PageContainer";
export { PageSkeleton } from "./kit/layout/PageSkeleton";
export { SectionCard } from "./kit/layout/SectionCard";
export { MobileNav } from "./kit/navigation/MobileNav";
export { NavigationLink } from "./kit/navigation/NavigationLink";
export { UsdcPaymentFlow } from "./kit/payments/UsdcPaymentFlow";
export { Hero } from "./kit/sections";
export {
  type CodeToken,
  CodeTokenLine,
  HeroActionContainer,
  HeroCodeBlock,
} from "./kit/typography/CodeHero";
export { HeroActionWords } from "./kit/typography/HeroActionWords";
export { Prompt } from "./kit/typography/Prompt";
