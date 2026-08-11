import Head from "next/head";
import { useState } from "react";
import PinnedTargetCard from "@/components/PinnedTargetCard";
import PinnedInstancesList from "@/components/PinnedInstancesList";
import ClaudeSessionsList from "@/components/ClaudeSessionsList";
import { pinnedLabel } from "@/mini-lib/config";

type Props = {
  pageError: string | null;
};

export default function Home({ pageError }: Props) {
  const [refreshSignal, setRefreshSignal] = useState(0);

  function changed() {
    setRefreshSignal((n) => n + 1);
  }

  return (
    <>
      <Head>
        <title>{`${pinnedLabel()} — Mini Launcher`}</title>
      </Head>
      <main>
        <div>
          <h1>{pinnedLabel()}</h1>
          <p className="subtitle">Pinned project — launch, manage, and browse Claude sessions.</p>
        </div>

        {pageError ? (
          <section className="panel">
            <p className="error-text">{pageError}</p>
          </section>
        ) : (
          <>
            <PinnedTargetCard onChanged={changed} />
            <PinnedInstancesList refreshSignal={refreshSignal} onChanged={changed} />
            <ClaudeSessionsList refreshSignal={refreshSignal} />
          </>
        )}
      </main>
    </>
  );
}

export async function getServerSideProps() {
  try {
    return { props: { pageError: null } };
  } catch (err: any) {
    return {
      props: {
        pageError: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
