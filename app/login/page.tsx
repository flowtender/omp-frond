"use client";

import Link from "next/link";
import { useState, type SubmitEvent } from "react";
import styles from "../recover/recover.module.css";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/web-access/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to sign in.");
      const next = new URLSearchParams(window.location.search).get("next");
      const destination = new URL(next || "/", window.location.origin);
      window.location.replace(destination.origin === window.location.origin && destination.pathname !== "/login" ? destination.href : "/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={(event) => void signIn(event)}>
        <div className={styles.eyebrow}>omp-frond</div>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.lead}>Enter your password to open omp-frond. This device stays signed in for 30 days.</p>
        <input name="username" autoComplete="username" value="omp" readOnly hidden />
        <label className={styles.field}>
          <span>Password</span>
          <input className={styles.input} name="password" type="password" autoComplete="current-password" required
            value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button className={styles.primary} type="submit" disabled={busy || !password}>{busy ? "Signing in…" : "Sign in"}</button>
        <Link className={styles.secondary} href="/recover">Recover access</Link>
      </form>
    </main>
  );
}
