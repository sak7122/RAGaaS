export function Privacy() {
  return (
    <div className="privacy-page">
      <div className="privacy-card">
        <h1 className="privacy-title">Privacy &amp; Data Policy</h1>
        <p className="privacy-sub">Last updated: June 2025</p>

        <section className="privacy-section">
          <h2>Data Residency</h2>
          <p>
            All customer data is stored and processed exclusively in the{" "}
            <strong>us-central1 (Iowa, USA)</strong> region on Google Cloud Platform.
            No data is replicated to other regions without explicit customer consent.
          </p>
        </section>

        <section className="privacy-section">
          <h2>Encryption</h2>
          <p>
            Data is encrypted <strong>at rest</strong> using AES-256 (managed by Google Cloud KMS)
            and <strong>in transit</strong> using TLS 1.2 or higher. PDF documents are stored in
            Google Cloud Storage with server-side encryption enabled by default.
          </p>
        </section>

        <section className="privacy-section">
          <h2>Data Retention &amp; Deletion</h2>
          <p>
            Documents and associated vector index data are retained for the duration of your
            subscription. Upon account cancellation or on request, all tenant data is permanently
            deleted within <strong>24 hours</strong>. Backups containing your data are purged
            within 30 days of deletion.
          </p>
          <p>
            You may request immediate deletion of all your data at any time by contacting{" "}
            <a href="mailto:privacy@ragaas.com">privacy@ragaas.com</a> or by using the
            &ldquo;Delete tenant data&rdquo; option in your account settings.
          </p>
        </section>

        <section className="privacy-section">
          <h2>Third-Party Processors</h2>
          <p>RAGaaS uses the following sub-processors to deliver the service:</p>
          <ul className="privacy-list">
            <li>
              <strong>Google Cloud Platform</strong> — compute (Cloud Run), storage (GCS),
              database (Firestore), and AI inference (Vertex AI).{" "}
              <a href="https://cloud.google.com/terms/data-processing-addendum" target="_blank" rel="noopener noreferrer">
                Google DPA
              </a>
            </li>
            <li>
              <strong>Firebase</strong> (Google) — user authentication.
            </li>
          </ul>
        </section>

        <section className="privacy-section">
          <h2>No Model Training on Customer Data</h2>
          <p>
            RAGaaS uses Google Vertex AI under an enterprise agreement that{" "}
            <strong>prohibits Google from using your data to train or improve AI models</strong>.
            Your uploaded documents are never used to train any foundation model.
          </p>
        </section>

        <section className="privacy-section">
          <h2>Tenant Isolation</h2>
          <p>
            Each organization (tenant) has a fully isolated storage namespace and query scope.
            Documents uploaded by one tenant are never accessible to another tenant,
            at the storage, search index, or API layer.
          </p>
        </section>

        <section className="privacy-section">
          <h2>Contact</h2>
          <p>
            Data privacy questions: <a href="mailto:privacy@ragaas.com">privacy@ragaas.com</a>
            <br />
            Security disclosures: <a href="mailto:security@ragaas.com">security@ragaas.com</a>
          </p>
        </section>
      </div>
    </div>
  );
}
