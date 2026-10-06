import { PageHeader } from '../components/ui/page-header';
import { ProvidersSection } from '../features/providers/ProvidersSection';
import { SystemInfo } from '../features/settings/SystemInfo';

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-6 md:px-8">
      <PageHeader title="Settings" description="AI providers and information about this installation." />
      <ProvidersSection />
      <SystemInfo />
    </div>
  );
}
