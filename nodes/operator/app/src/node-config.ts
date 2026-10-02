import type { NodeAppConfig } from "@cogni/node-app/extensions";
import {
  Boxes,
  Briefcase,
  CreditCard,
  Github,
  LayoutDashboard,
  Vote,
} from "lucide-react";

export const nodeConfig: NodeAppConfig = {
  name: "Cogni Operator",
  logo: { src: "/TransparentBrainOnly.png", alt: "Cogni", href: "/chat" },
  navItems: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/work", label: "Work", icon: Briefcase },
    { href: "/nodes", label: "Nodes", icon: Boxes },
    { href: "/gov", label: "Gov", icon: Vote },
    { href: "/credits", label: "Credits", icon: CreditCard },
  ],
  externalLinks: [
    { href: "https://github.com/cogni-dao", label: "GitHub", icon: Github },
  ],
};
