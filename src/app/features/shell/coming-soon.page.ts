import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { Workspace } from '../../core/workspace';
import { FeatureSelection } from '../../core/feature-selection';
import { ROLE_LABELS } from '../../core/config/team-config';

/** Placeholder for screens that arrive in later milestones. */
@Component({
  selector: 'app-coming-soon-page',
  imports: [RouterLink],
  template: `
    <main class="page stack">
      <h1>{{ data().heading }}</h1>

      <section class="card stack">
        @if (features.project(); as p) {
          <div class="row">
            <span class="muted">Feature</span>
            <a [href]="p.url" target="_blank" rel="noopener"><strong>{{ p.title }}</strong></a>
            @if (features.settings()?.targetVersion; as v) {
              <span class="muted">· target v{{ v }}</span>
            }
            @if (features.settings()?.releaseDate; as d) {
              <span class="muted">· release {{ d }}</span>
            }
          </div>
        } @else if (ws.projects().length === 0 && !ws.projectsError()) {
          <p class="muted">
            No feature boards are linked to this repo yet. Create a GitHub Project for the feature and
            link it to the repo from the project's settings.
          </p>
        }
        <p>{{ data().blurb }}</p>
        <p class="muted small">This screen arrives in milestone {{ data().milestone }}.</p>
        @if (roles().length) {
          <p class="muted small">You're set up as {{ roles() }}.</p>
        }
      </section>

      @if (ws.canEditTeam()) {
        <p class="muted small">
          Next step while you wait: <a routerLink="../settings/team" queryParamsHandling="preserve">add your team</a>.
        </p>
      }
    </main>
  `,
})
export class ComingSoonPage {
  protected readonly ws = inject(Workspace);
  protected readonly features = inject(FeatureSelection);
  private readonly route = inject(ActivatedRoute);

  protected readonly data = toSignal(
    this.route.data.pipe(map((d) => d as { heading: string; milestone: string; blurb: string })),
    { requireSync: true },
  );
  protected readonly roles = computed(() =>
    this.ws
      .roles()
      .map((r) => ROLE_LABELS[r])
      .join(', '),
  );
}
