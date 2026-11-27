"use client";

import { AnchorLogo } from "@/components/layout/anchor-logo";
import { AppPage, PageTitle } from "@/components/layout/app-page";
import { Button } from "@/components/ui/button";
import {
  ApiTokenSection,
  AppearanceSection,
  DeleteAccountSection,
  EditorSection,
  ImportExportSection,
  PasswordSection,
  ProfileSection,
  Row,
  RowText,
  Section,
  SecuritySection,
  SettingsNav,
} from "@/features/settings";

export default function SettingsPage() {
  return (
    <AppPage title={<PageTitle>Settings</PageTitle>} scrollKey="settings">
      <div className="grid grid-cols-[176px_minmax(0,640px)] items-start gap-10 pt-1 max-md:grid-cols-[minmax(0,1fr)] max-md:gap-5">
        <SettingsNav />
        <div className="grid min-w-0 gap-8">
          <ProfileSection />
          <AppearanceSection />
          <EditorSection />
          <ApiTokenSection />
          <ImportExportSection />
          <PasswordSection />
          <SecuritySection />
          <DeleteAccountSection />
          <Section id="about" title="About">
            <Row>
              <div className="flex items-center gap-3">
                <AnchorLogo className="size-10" />
                <div className="grid">
                  <b className="font-semibold text-ui">
                    Bordo {import.meta.env.VITE_APP_VERSION}
                  </b>
                  <span className="text-meta text-muted-foreground">
                    Your thoughts, secured.
                  </span>
                </div>
              </div>
            </Row>
            <Row>
              <RowText
                title="Phone apps"
                text="Anchor for Android and iPhone, synced with this server."
              />
              <div className="flex flex-wrap gap-2">
                <ExternalLink href="https://play.google.com/store/apps/details?id=com.zhfahim.anchor">
                  Google Play
                </ExternalLink>
                <ExternalLink href="https://github.com/ZhFahim/anchor/releases/latest">
                  APK
                </ExternalLink>
                <ExternalLink href="https://testflight.apple.com/join/5982frnz">
                  TestFlight
                </ExternalLink>
              </div>
            </Row>
            <Row>
              <RowText
                title="Source code"
                text="Releases, bug reports and feature requests."
              />
              <ExternalLink href="https://github.com/ZhFahim/anchor">
                GitHub
              </ExternalLink>
            </Row>
            <Row>
              <RowText title="Community" text="Questions and help." />
              <ExternalLink href="https://discord.gg/sAfqjy8EYK">
                Discord
              </ExternalLink>
            </Row>
          </Section>
        </div>
      </div>
    </AppPage>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Button variant="secondary" asChild>
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    </Button>
  );
}
