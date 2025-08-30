export default function TermsPage() {
  return (
    <main
      style={{
        padding: 24,
        maxWidth: 840,
        margin: "0 auto",
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.6,
      }}
    >
      <h1>Terms of Use</h1>
      <p>
        <em>Effective date: {new Date().toISOString().slice(0, 10)}</em>
      </p>

      <p>
        These Terms of Use ("Terms") govern your access to and use of the Notion Magic Clipper
        browser extension and its companion backend (collectively, the "Service"). By installing or
        using the Service, you agree to be bound by these Terms.
      </p>

      <h2>1. Description of the Service</h2>
      <p>
        The Service lets you save the current web page to a Notion database you control. Optionally,
        you may enable an AI provider to help fill Notion properties and generate concise page
        content. The Service interacts with third‑party APIs, including Notion, and—if you
        choose—OpenAI or Google AI.
      </p>

      <h2>2. Your Responsibilities</h2>
      <ul>
        <li>You must have the necessary rights to save the content you clip to Notion.</li>
        <li>You must comply with Notion’s terms and any applicable third‑party terms.</li>
        <li>
          You will not use the Service to infringe intellectual property rights or violate
          applicable laws.
        </li>
      </ul>

      <h2>3. Privacy</h2>
      <p>
        Your use of the Service is also governed by our <a href="/privacy">Privacy Policy</a>, which
        describes what data we collect and how we use it. In short, the extension stores your
        preferences and credentials locally and sends content only as needed to Notion and, if
        enabled, to your selected AI provider.
      </p>

      <h2>4. Third‑Party Services</h2>
      <p>
        The Service depends on third‑party services (e.g., Notion, OpenAI, Google). We do not
        control these services and are not responsible for their availability, performance, or
        terms. Your use of any third‑party service is subject to its own terms and policies.
      </p>

      <h2>5. Intellectual Property</h2>
      <p>
        The Service is provided under copyright by its authors. These Terms do not grant you any
        trademark, logo, or ownership rights in the Service. You retain ownership of your content
        saved to Notion.
      </p>

      <h2>6. Termination</h2>
      <p>
        You may stop using the Service at any time by removing the extension and disconnecting your
        Notion workspace. We may suspend or terminate access if you violate these Terms or misuse
        the Service.
      </p>

      <h2>7. Disclaimers</h2>
      <p>
        THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE” WITHOUT WARRANTIES OF ANY KIND, WHETHER
        EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO MERCHANTABILITY, FITNESS FOR A PARTICULAR
        PURPOSE, AND NON‑INFRINGEMENT. We do not warrant that the Service will be error‑free or
        uninterrupted.
      </p>

      <h2>8. Limitation of Liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
        SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF DATA, PROFITS, OR REVENUE,
        ARISING FROM OR RELATED TO YOUR USE OF THE SERVICE.
      </p>

      <h2>9. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. We will post changes on this page and update
        the effective date above. Your continued use of the Service after changes take effect
        constitutes acceptance.
      </p>

      <h2>10. Contact</h2>
      <p>If you have questions about these Terms, please open an issue on our GitHub repository.</p>
    </main>
  );
}
