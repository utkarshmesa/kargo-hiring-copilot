import type { ExtractorOutput } from "@/lib/gemini/extractor";

// A hand-written Extractor output for a fictional candidate, used by redaction tests.
// Identity is planted everywhere the rubric says it can hide.
export function sampleExtractor(overrides: Partial<ExtractorOutput> = {}): ExtractorOutput {
  return {
    identity: {
      name: "Priya Raghavan",
      emails: ["priya.raghavan@example.com"],
      phones: ["+91 98765 43210"],
      urls: ["linkedin.com/in/priyaraghavan"],
      locations: ["Pune, Maharashtra"],
    },
    roles: [
      {
        title: "Operations Lead",
        company_raw: "Zephyrline Logistics Pvt. Ltd.",
        company_descriptor: "Mid-sized freight forwarder, ~120 staff",
        start_raw: "Mar 2021",
        end_raw: "Present",
        bullets: [
          "Built Zephyrline's first exception dashboard; adopted by 3 other branches within 2 months",
          'Manager review: "Priya owns every escalation. She never waits to be asked, and her fixes stick."',
          "Ran the Pune branch after the manager left in Jan 2022, with no layer above except the COO",
          "Returned to work after a two-year career break to care for family",
        ],
      },
      {
        title: "Documentation Executive",
        company_raw: "Harbourstone Shipping Services",
        company_descriptor: "Small NVOCC operator",
        start_raw: "Jul 2016",
        end_raw: "Feb 2019",
        bullets: [
          "Handled 150+ shipments monthly at JNPT; worked with Mr. Kulkarni on customs holds",
          "Presented the new SOP at IIM Ahmedabad's logistics conference (2018)",
        ],
      },
    ],
    education: [
      { degree_field: "B.Com, Accounting", institution_raw: "Symbiosis College of Arts and Commerce", certifications: ["IATA DGR (2019)"] },
    ],
    summary_raw:
      "Operations professional based in Pune with 7 years in freight forwarding. Married, two children. Fluent in Marathi and English. Priya Raghavan is comfortable owning processes end to end.",
    skills_raw: ["CargoWise One", "Languages: Marathi, Hindi, English", "Python", "Excel"],
    relocation_statement: "Happy to relocate to Mumbai.",
    ...overrides,
  };
}
