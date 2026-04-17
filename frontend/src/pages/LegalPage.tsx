import { Link } from 'react-router-dom';

export default function LegalPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link
            to="/"
            className="inline-flex items-center text-primary-600 hover:text-primary-800 dark:text-primary-400 dark:hover:text-primary-300"
          >
            ← Back to home
          </Link>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 md:p-12">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            Impressum & Datenschutzerklärung
          </h1>

          <div className="mt-8 space-y-12">
            <div className="border-b border-gray-200 dark:border-gray-700 pb-8">
              <h2 className="text-2xl font-semibold mb-6">Impressum</h2>
              <p className="text-lg font-medium mb-4">Angaben gemäß § 5 TMG:</p>

              <div className="mb-6 text-gray-700 dark:text-gray-300">
                <p>Sebastian Roekens</p>
                <p>Philipp-Nicolai-Weg 16</p>
                <p>58313 Herdecke</p>
              </div>

              <div className="mb-6 text-gray-700 dark:text-gray-300">
                <h3 className="text-lg font-medium mb-2">Kontakt:</h3>
                <p>Telefon: +49 176 56061274</p>
                <p>E-Mail: sebastian.roekens@googlemail.com</p>
              </div>

              <p className="mb-8 text-gray-700 dark:text-gray-300">
                Als Privatperson i. S. d. § 5 TMG wird auf die Umsatzsteuer-ID verzichtet.
              </p>

              <div className="space-y-8 text-gray-700 dark:text-gray-300">
                <section>
                  <h3 className="text-xl font-semibold mb-4">
                    Haftungshinweis: Haftung für Inhalte
                  </h3>
                  <p className="leading-relaxed">
                    Die Inhalte unserer Seiten wurden mit größter Sorgfalt erstellt. Für die
                    Richtigkeit, Vollständigkeit und Aktualität der Inhalte können wir jedoch keine
                    Gewähr übernehmen. Als Diensteanbieter sind wir gemäß § 7 Abs.1 TMG für eigene
                    Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich. Nach §§
                    8 bis 10 TMG sind wir als Diensteanbieter jedoch nicht verpflichtet,
                    übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach
                    Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.
                    Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach
                    allgemeinen Gesetzen bleiben hiervon unberührt. Eine diesbezügliche Haftung ist
                    jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung
                    möglich. Bei Bekanntwerden von entsprechenden Rechtsverletzungen werden wir
                    diese Inhalte umgehend entfernen.
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">Haftung für Links</h3>
                  <p className="leading-relaxed">
                    Unser Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir
                    keinen Einfluss haben. Deshalb können wir für diese fremden Inhalte auch keine
                    Gewähr übernehmen. Für die Inhalte der verlinkten Seiten ist stets der jeweilige
                    Anbieter oder Betreiber der Seiten verantwortlich. Die verlinkten Seiten wurden
                    zum Zeitpunkt der Verlinkung auf mögliche Rechtsverstöße überprüft.
                    Rechtswidrige Inhalte waren zum Zeitpunkt der Verlinkung nicht erkennbar. Eine
                    permanente inhaltliche Kontrolle der verlinkten Seiten ist jedoch ohne konkrete
                    Anhaltspunkte einer Rechtsverletzung nicht zumutbar. Bei Bekanntwerden von
                    Rechtsverletzungen werden wir derartige Links umgehend entfernen.
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">Urheberrecht</h3>
                  <p className="leading-relaxed">
                    Die durch die Seitenbetreiber erstellten Inhalte und Werke auf diesen Seiten
                    unterliegen dem deutschen Urheberrecht. Die Vervielfältigung, Bearbeitung,
                    Verbreitung und jede Art der Verwertung außerhalb der Grenzen des Urheberrechts
                    bedürfen der schriftlichen Zustimmung des jeweiligen Autors bzw. Erstellers.
                    Downloads und Kopien dieser Seite sind nur für den privaten, nicht kommerziellen
                    Gebrauch gestattet. Soweit die Inhalte auf dieser Seite nicht vom Betreiber
                    erstellt wurden, werden die Urheberrechte Dritter beachtet. Insbesondere werden
                    Inhalte Dritter als solche gekennzeichnet. Sollten Sie trotzdem auf eine
                    Urheberrechtsverletzung aufmerksam werden, bitten wir um einen entsprechenden
                    Hinweis. Bei Bekanntwerden von Rechtsverletzungen werden wir derartige Inhalte
                    umgehend entfernen.
                  </p>
                </section>
              </div>
            </div>

            <div>
              <h2 className="text-2xl font-semibold mb-6">Datenschutzerklärung</h2>

              <div className="mb-8 text-gray-700 dark:text-gray-300">
                <h3 className="text-lg font-medium mb-2">Verantwortlicher im Sinne der DSGVO:</h3>
                <p>Sebastian Roekens (siehe oben)</p>
              </div>

              <div className="space-y-10 text-gray-700 dark:text-gray-300">
                <section>
                  <h3 className="text-xl font-semibold mb-4">1. Allgemeines</h3>
                  <p className="leading-relaxed">
                    Diese Datenschutzerklärung klärt Sie über die Art, den Umfang und Zweck der
                    Verarbeitung personenbezogener Daten innerhalb unserer Website estimatenest.net
                    auf. Personenbezogene Daten sind alle Daten, mit denen Sie persönlich
                    identifiziert werden können.
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">2. Rechtsgrundlagen</h3>
                  <p className="leading-relaxed">
                    Die Verarbeitung personenbezogener Daten erfolgt auf Grundlage der DSGVO und des
                    TMG.
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">3. Hosting</h3>
                  <p className="leading-relaxed">
                    Die Website wird auf Servern von Amazon Web Services (AWS), Region eu-central-1
                    (Frankfurt, EU), gehostet. AWS agiert als Auftragsverarbeiter gem. Art. 28
                    DSGVO. Weitere Infos:
                    <a
                      href="https://aws.amazon.com/de/compliance/gdpr-center/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary-600 hover:text-primary-800 dark:text-primary-400 dark:hover:text-primary-300 ml-1"
                    >
                      https://aws.amazon.com/de/compliance/gdpr-center/
                    </a>
                    . Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO.
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">
                    4. Erhebung personenbezogener Daten beim Besuch der Website
                  </h3>
                  <p className="leading-relaxed">
                    Beim Aufruf unserer Website speichert der Server automatisch:
                  </p>
                  <ul className="list-disc pl-5 mt-2 mb-4 space-y-1">
                    <li>IP-Adresse (anonymisiert)</li>
                    <li>Datum und Uhrzeit des Zugriffs</li>
                    <li>Browser-Typ und Version</li>
                    <li>Referrer-URL</li>
                    <li>Verwendetes Betriebssystem</li>
                  </ul>
                  <p className="leading-relaxed">
                    Zweck: Technische Optimierung und Sicherheit. Speicherdauer: 7 Tage.
                    Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse).
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">5. Cookies</h3>
                  <p className="leading-relaxed">
                    Unsere Website verwendet keine Tracking-Cookies. Session-Cookies dienen nur der
                    Funktionalität und werden nach Sitzungsende gelöscht. Sie können Cookies in den
                    Browser-Einstellungen deaktivieren.
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">6. Schätzräume</h3>
                  <p className="leading-relaxed">
                    Eingegebene Daten in Schätzräumen werden 2 Wochen nach Erstellung gespeichert
                    (Zweck: Nutzung und Überprüfung). Danach erfolgt automatische Löschung.
                    Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an der
                    Serviceerbringung).
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">7. Kontakt per E-Mail</h3>
                  <p className="leading-relaxed">
                    Bei Kontaktaufnahme per E-Mail speichern wir Name, E-Mail und Nachricht. Zweck:
                    Bearbeitung der Anfrage. Rechtsgrundlage: Art. 6 Abs. 1 lit. b/f DSGVO.
                    Speicherdauer: Bis Abschluss der Anfrage, dann Löschung.
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">8. Ihre Rechte</h3>
                  <p className="leading-relaxed">
                    Sie haben Recht auf Auskunft, Berichtigung, Löschung, Einschränkung,
                    Datenübertragbarkeit und Widerspruch (Art. 15-22 DSGVO). Kontaktieren Sie uns
                    hierzu. Widerruf jederzeit möglich. Beschwerde bei der
                    Landesdatenschutzbeauftragten Nordrhein-Westfalen (
                    <a
                      href="https://ldi.nrw.de/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary-600 hover:text-primary-800 dark:text-primary-400 dark:hover:text-primary-300"
                    >
                      https://ldi.nrw.de/
                    </a>
                    ).
                  </p>
                </section>

                <section>
                  <h3 className="text-xl font-semibold mb-4">9. Datensicherheit</h3>
                  <p className="leading-relaxed">
                    Wir nutzen technische und organisatorische Maßnahmen (z. B. HTTPS, Firewalls bei
                    AWS).
                  </p>
                </section>
              </div>

              <div className="mt-12 pt-6 border-t border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-sm">
                <p>
                  <strong>Stand:</strong> April 2026
                  <br />
                  Änderungen vorbehalten.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
