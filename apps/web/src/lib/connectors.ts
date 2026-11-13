import type { ConnectorKind } from './types';

export const CONNECTOR_ORDER: ConnectorKind[] = ['zoho_crm', 'zoho_bigin', 'hubspot', 'salesforce', 'webhook', 'csv'];

export const CONNECTOR_LABEL: Record<ConnectorKind, string> = {
  zoho_crm: 'Zoho CRM', zoho_bigin: 'Zoho Bigin', hubspot: 'HubSpot', salesforce: 'Salesforce', webhook: 'Webhook', csv: 'Excel / CSV',
};
export function defaultMapping(kind: ConnectorKind): Record<string, string> {
  const m: Record<ConnectorKind, Record<string, string>> = {
    zoho_crm: { first_name: 'First_Name', last_name: 'Last_Name', company: 'Company', job_title: 'Designation', email: 'Email', phone: 'Mobile', website: 'Website', country: 'Country' },
    zoho_bigin: { first_name: 'First_Name', last_name: 'Last_Name', company: 'Account_Name', job_title: 'Title', email: 'Email', phone: 'Mobile', website: 'Website', country: 'Mailing_Country' },
    hubspot: { first_name: 'firstname', last_name: 'lastname', company: 'company', job_title: 'jobtitle', email: 'email', phone: 'mobilephone', website: 'website', country: 'country' },
    salesforce: { first_name: 'FirstName', last_name: 'LastName', company: 'Company', job_title: 'Title', email: 'Email', phone: 'MobilePhone', website: 'Website', country: 'Country' },
    webhook: { first_name: 'first_name', last_name: 'last_name', company: 'company', job_title: 'job_title', email: 'email', phone: 'phone', website: 'website', country: 'country' },
    csv: {},
  };
  return m[kind];
}
