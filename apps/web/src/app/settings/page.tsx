'use client';

import type { ReactNode } from 'react';
import { SlidersHorizontal, RotateCcw, PanelsTopLeft, Shield, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_APP_SETTINGS, useAppSettings } from '@/components/settings-provider';

function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-background/60 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { settings, setSetting, resetSettings } = useAppSettings();

  return (
    <main className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-6 overflow-y-auto px-4 py-6">
      <section className="rounded-2xl border border-border bg-card/80 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Settings</p>
            <h1 className="text-2xl font-semibold text-foreground">Tune the app to your workflow</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Control confirmations, layout, Studio defaults, and how much status information the interface shows while you work.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={resetSettings}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset defaults
          </Button>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <Shield className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Safety and confirmations</h2>
            </div>
            <div className="mt-4 space-y-3">
              <SettingRow
                title="Confirm finished-image deletes"
                description="Ask before removing completed generations that already produced image files."
                control={(
                  <Switch
                    checked={settings.confirmDeleteFinishedImages}
                    onCheckedChange={(checked) => setSetting('confirmDeleteFinishedImages', checked)}
                  />
                )}
              />
              <SettingRow
                title="Confirm cancelled-job deletes"
                description="Ask before deleting cancelled jobs from history."
                control={(
                  <Switch
                    checked={settings.confirmDeleteCancelledJobs}
                    onCheckedChange={(checked) => setSetting('confirmDeleteCancelledJobs', checked)}
                  />
                )}
              />
              <SettingRow
                title="Confirm stop actions"
                description="Ask before stopping queued or active generations."
                control={(
                  <Switch
                    checked={settings.confirmStopJobs}
                    onCheckedChange={(checked) => setSetting('confirmStopJobs', checked)}
                  />
                )}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <SlidersHorizontal className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Studio behavior</h2>
            </div>
            <div className="mt-4 space-y-3">
              <SettingRow
                title="Auto-select new jobs"
                description="Switch the canvas and history focus to the first job in each newly queued batch."
                control={(
                  <Switch
                    checked={settings.autoSelectNewJobs}
                    onCheckedChange={(checked) => setSetting('autoSelectNewJobs', checked)}
                  />
                )}
              />
              <SettingRow
                title="Persist Studio draft"
                description="Keep your left-panel draft when you navigate to Models, LoRAs, Help, or Settings."
                control={(
                  <Switch
                    checked={settings.persistStudioDraft}
                    onCheckedChange={(checked) => setSetting('persistStudioDraft', checked)}
                  />
                )}
              />
              <SettingRow
                title="Open advanced controls by default"
                description="Start Studio with the advanced generation section expanded when no saved draft overrides it."
                control={(
                  <Switch
                    checked={settings.defaultAdvancedOpen}
                    onCheckedChange={(checked) => setSetting('defaultAdvancedOpen', checked)}
                  />
                )}
              />
              <SettingRow
                title="Show model guidance card"
                description="Display the recommended defaults card under the selected model in Studio."
                control={(
                  <Switch
                    checked={settings.showModelGuidanceCard}
                    onCheckedChange={(checked) => setSetting('showModelGuidanceCard', checked)}
                  />
                )}
              />
            </div>
          </section>
        </div>

        <div className="space-y-4">
          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <Eye className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Display and history</h2>
            </div>
            <div className="mt-4 space-y-3">
              <SettingRow
                title="Show ETA labels"
                description="Display remaining-time estimates in the canvas and history."
                control={(
                  <Switch
                    checked={settings.showEta}
                    onCheckedChange={(checked) => setSetting('showEta', checked)}
                  />
                )}
              />
              <SettingRow
                title="Show elapsed time"
                description="Display live elapsed runtime while jobs are active."
                control={(
                  <Switch
                    checked={settings.showElapsed}
                    onCheckedChange={(checked) => setSetting('showElapsed', checked)}
                  />
                )}
              />
              <SettingRow
                title="Show seeds"
                description="Surface seed values in the canvas status bar and history details."
                control={(
                  <Switch
                    checked={settings.showSeed}
                    onCheckedChange={(checked) => setSetting('showSeed', checked)}
                  />
                )}
              />
              <SettingRow
                title="Show queue positions"
                description="Display queue numbers on active and pending jobs."
                control={(
                  <Switch
                    checked={settings.showQueuePosition}
                    onCheckedChange={(checked) => setSetting('showQueuePosition', checked)}
                  />
                )}
              />
              <SettingRow
                title="Show active phase checklist"
                description="Display the full step-by-step phase list while a generation is actively running."
                control={(
                  <Switch
                    checked={settings.showPhaseChecklist}
                    onCheckedChange={(checked) => setSetting('showPhaseChecklist', checked)}
                  />
                )}
              />
              <SettingRow
                title="Show prompt under canvas"
                description="Keep the latest prompt visible below the active image."
                control={(
                  <Switch
                    checked={settings.showPromptFooter}
                    onCheckedChange={(checked) => setSetting('showPromptFooter', checked)}
                  />
                )}
              />
              <SettingRow
                title="Compact history cards"
                description="Reduce padding and thumbnail size in the history list for a denser queue view."
                control={(
                  <Switch
                    checked={settings.compactHistoryCards}
                    onCheckedChange={(checked) => setSetting('compactHistoryCards', checked)}
                  />
                )}
              />
              <SettingRow
                title="History page size"
                description="Choose how many jobs appear per history page."
                control={(
                  <Select
                    value={String(settings.historyPageSize)}
                    onValueChange={(value) => setSetting('historyPageSize', parseInt(value, 10))}
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="20">20</SelectItem>
                      <SelectItem value="40">40</SelectItem>
                      <SelectItem value="60">60</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <PanelsTopLeft className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Layout defaults</h2>
            </div>
            <div className="mt-4 space-y-3">
              <SettingRow
                title="Default left pane width"
                description="Set the starting width for the Studio settings rail."
                control={(
                  <div className="w-28 space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Pixels</Label>
                    <Input
                      type="number"
                      min={280}
                      max={520}
                      step={10}
                      value={settings.leftPaneWidth}
                      onChange={(event) => setSetting('leftPaneWidth', parseInt(event.target.value || '320', 10))}
                    />
                  </div>
                )}
              />
              <SettingRow
                title="Default right pane width"
                description="Set the starting width for the Studio history panel."
                control={(
                  <div className="w-28 space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Pixels</Label>
                    <Input
                      type="number"
                      min={280}
                      max={520}
                      step={10}
                      value={settings.rightPaneWidth}
                      onChange={(event) => setSetting('rightPaneWidth', parseInt(event.target.value || '320', 10))}
                    />
                  </div>
                )}
              />
            </div>
          </section>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card/80 p-5">
        <p className="text-sm text-muted-foreground">
          Current defaults: {DEFAULT_APP_SETTINGS.historyPageSize} history items per page, {DEFAULT_APP_SETTINGS.leftPaneWidth}px left pane, {DEFAULT_APP_SETTINGS.rightPaneWidth}px right pane.
        </p>
      </section>
    </main>
  );
}
