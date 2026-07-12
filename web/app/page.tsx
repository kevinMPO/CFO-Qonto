"use client";

import { useState } from "react";
import Argentier from "./Argentier";
import Landing from "./Landing";

export default function Page() {
  const [view, setView] = useState<"landing" | "app">("landing");
  if (view === "landing") return <Landing onDemo={() => setView("app")} />;
  return <Argentier />;
}
