import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KbNotice } from './KbNotice';

const show = (props: React.ComponentProps<typeof KbNotice>) =>
  render(
    <MemoryRouter>
      <KbNotice {...props} />
    </MemoryRouter>,
  );

describe('KbNotice', () => {
  it('explains that an empty knowledge base cannot ground answers and links to it', () => {
    show({ kbId: 'kb1', ready: 0, processing: 0 });
    expect(screen.getByRole('status')).toHaveTextContent('no ready documents');
    expect(screen.getByRole('link', { name: 'Add documents' })).toHaveAttribute('href', '/knowledge-bases/kb1');
  });

  it('warns that answers may be incomplete while documents are still being indexed', () => {
    show({ kbId: 'kb1', ready: 5, processing: 3 });
    expect(screen.getByRole('status')).toHaveTextContent('3 documents are still being indexed');
    expect(screen.getByRole('status')).toHaveTextContent('incomplete');
  });

  it('uses the singular for one document', () => {
    show({ kbId: 'kb1', ready: 0, processing: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('1 document is still being indexed');
  });

  it('shows nothing when everything is ready', () => {
    show({ kbId: 'kb1', ready: 12, processing: 0 });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows nothing while readiness is unknown', () => {
    show({ kbId: 'kb1', ready: undefined, processing: undefined });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
