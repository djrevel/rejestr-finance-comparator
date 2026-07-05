import './globals.css';

export const metadata = {
  title: 'Porównywarka sprawozdań Rejestr.io',
  description: 'Porównanie bilansu, RZiS i KPI dla wielu spółek na bazie API Rejestr.io'
};

export default function RootLayout({ children }) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
