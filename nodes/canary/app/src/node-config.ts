import type { NodeAppConfig } from "@cogni/node-app/extensions";
import {
  BookOpen,
  CreditCard,
  Github,
  LayoutDashboard,
  Shield,
  Briefcase,
  Vote,
} from "lucide-react";

export const nodeConfig: NodeAppConfig = {
  name: "Canary",
  logo: { src: "/TransparentBrainOnly.png", alt: "Canary", href: "/chat" },
  navItems: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/work", label: "Work", icon: Briefcase },
    { href: "/knowledge", label: "Knowledge", icon: BookOpen },
    { href: "/gov", label: "Gov", icon: Vote },
    { href: "/credits", label: "Credits", icon: CreditCard },
    { href: "/admin", label: "Admin", icon: Shield },
  ],
  externalLinks: [
    {
      href: "https://github.com/openclaw/openclaw",
      label: "OpenClaw",
      icon: Github,
    },
  ],
};
