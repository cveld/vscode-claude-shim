import Head from "next/head";
import { useState } from "react";
import RootBrowser from "../components/RootBrowser";
import RecentList from "../components/RecentList";
import InstancesList from "../components/InstancesList";
import ShimSettings from "../components/ShimSettings";

export default function Home() {
  const [refreshSignal, setRefreshSignal] = useState(0);

  return (
    <>
      <Head>
        <title>VSCode Claude Shim — Launcher</title>
      </Head>
      <main>
        <div>
          <h1>VSCode Claude Shim</h1>
          <p className="subtitle">Launch a project-scoped code-server instance, or manage running ones.</p>
        </div>
        <RecentList refreshSignal={refreshSignal} onLaunched={() => setRefreshSignal((n) => n + 1)} />
        <RootBrowser onLaunched={() => setRefreshSignal((n) => n + 1)} />
        <InstancesList refreshSignal={refreshSignal} />
        <ShimSettings />
      </main>
    </>
  );
}
