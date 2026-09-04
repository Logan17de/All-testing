export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">ZET HARNESS</p>
        <h1 id="page-title">The harness is alive.</h1>
        <p className="lede">
          A provider-neutral runtime for models, tools, goals, memory, and agent workflows.
        </p>
        <div className="status" role="status">
          <span className="statusDot" aria-hidden="true" />
          Web shell ready
        </div>
      </section>
    </main>
  );
}
