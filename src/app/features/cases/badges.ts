import { Component, computed, input } from '@angular/core';
import { Platform, Priority } from '../../core/config/team-config';
import { PLATFORM_NAMES, Person, STATUS_LABELS, Status } from '../../core/testcase/model';
import { Step } from '../../core/testcase/gherkin';
import { avatarAt } from '../../core/avatar';

@Component({
  selector: 'app-priority',
  template: `@if (value(); as p) {<span [class]="'badge badge-' + p.toLowerCase()">{{ p }}</span>}`,
})
export class PriorityBadge {
  readonly value = input<Priority | null>(null);
}

@Component({
  selector: 'app-status',
  template: `<span [class]="'badge ' + cls()">{{ label() }}</span>`,
})
export class StatusBadge {
  readonly value = input<Status | null>(null);
  readonly closed = input(false);
  protected readonly cls = computed(() => (this.closed() ? 'status-closed' : `status-${this.value() ?? 'draft'}`));
  protected readonly label = computed(() =>
    this.closed() ? "Won't test" : this.value() ? STATUS_LABELS[this.value()!] : 'No status',
  );
}

@Component({
  selector: 'app-platforms',
  template: `@for (p of value(); track p) {<span class="badge badge-outline">{{ names[p] }}</span>}`,
  styles: `:host { display: inline-flex; gap: 4px; }`,
})
export class PlatformBadges {
  readonly value = input<Platform[]>([]);
  protected readonly names = PLATFORM_NAMES;
}

@Component({
  selector: 'app-avatars',
  template: `
    <span class="avatars">
      @for (p of people(); track p.login) {
        <img class="avatar" [src]="sized(p.avatarUrl)" [alt]="p.login" [title]="p.login" />
      }
    </span>
  `,
})
export class Avatars {
  readonly people = input<Person[]>([]);
  protected readonly sized = (url: string) => avatarAt(url, 44);
}

/** Read-only Gherkin with highlighted keywords. */
@Component({
  selector: 'app-gherkin',
  template: `<pre class="gherkin"><span class="kw">Scenario:</span> {{ name() }}
@for (s of steps(); track $index) {{{ s.keyword === 'And' ? '    ' : '  ' }}<span class="kw">{{ s.keyword }}</span> {{ s.text }}
}</pre>`,
})
export class GherkinView {
  readonly name = input('');
  readonly steps = input<Step[]>([]);
}

