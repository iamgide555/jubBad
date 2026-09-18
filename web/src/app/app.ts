import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppShell } from './shared/app-shell/app-shell';

@Component({
  imports: [RouterOutlet, AppShell],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {}
