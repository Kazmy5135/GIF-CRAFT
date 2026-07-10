interface PlaceholderPageProps {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <main className="page-content">
      <header className="page-header">
        <h1>{title}</h1>
        <p>模块状态：Planned</p>
      </header>
      <section className="panel placeholder-panel">
        <h2>功能尚未实现</h2>
        <p>{description}</p>
      </section>
    </main>
  );
}
