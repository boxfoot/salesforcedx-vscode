/*
 * Copyright (c) 2017, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as os from 'os';
import * as vscode from 'vscode';
import events = require('events');
import fs = require('fs');
import ospath = require('path');
import {
  CliCommandExecutor,
  Command
} from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import { ContinueResponse } from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import { getApexTests, isLanguageClientReady } from '..';
import {
  APEX_GROUP_RANGE,
  DARK_BLUE_BUTTON,
  DARK_GREEN_BUTTON,
  DARK_RED_BUTTON,
  LIGHT_BLUE_BUTTON,
  LIGHT_GREEN_BUTTON,
  LIGHT_RED_BUTTON
} from '../constants';
import { nls } from '../messages';
import { ApexTestMethod } from './LSPConverter';
import { FullTestResult, TestSummarizer } from './TestDataAccessObjects';

// Message
const LOADING_MESSAGE = nls.localize('force_test_view_loading_message');
const NO_TESTS_MESSAGE = nls.localize('force_test_view_no_tests_message');
const NO_TESTS_DESCRIPTION = nls.localize(
  'force_test_view_no_tests_description'
);

// Import from core
const sfdxCoreExports = vscode.extensions.getExtension(
  'salesforce.salesforcedx-vscode-core'
)!.exports;
const EmptyParametersGatherer = sfdxCoreExports.EmptyParametersGatherer;
const SfdxCommandlet = sfdxCoreExports.SfdxCommandlet;
const ForceApexTestRunCodeActionExecutor =
  sfdxCoreExports.ForceApexTestRunCodeActionExecutor;
const SfdxWorkspaceChecker = sfdxCoreExports.SfdxWorkspaceChecker;
const channelService = sfdxCoreExports.channelService;

export class ApexTestOutlineProvider
  implements vscode.TreeDataProvider<TestNode> {
  private static instance: ApexTestOutlineProvider;
  private onDidChangeTestData: vscode.EventEmitter<
    TestNode | undefined
  > = new vscode.EventEmitter<TestNode | undefined>();
  public onDidChangeTreeData = this.onDidChangeTestData.event;

  private eventsEmitter = new events.EventEmitter();

  private apexTestMap: Map<string, TestNode> = new Map<string, TestNode>();
  private rootNode: TestNode | null;
  private static testStrings: Set<string> = new Set<string>();
  private path: string;
  private apexTestInfo: ApexTestMethod[] | null;

  public static getInstance(): ApexTestOutlineProvider {
    if (ApexTestOutlineProvider.instance) {
      return ApexTestOutlineProvider.instance;
    } else {
      // const apexTests = await getApexTests();
      return new ApexTestOutlineProvider(
        vscode.workspace.workspaceFolders![0].name,
        null
      );
    }
  }

  constructor(path: string, apexTestInfo: ApexTestMethod[] | null) {
    ApexTestOutlineProvider.instance = this;
    this.rootNode = null;
    this.path = path;
    this.apexTestInfo = apexTestInfo;
    this.getAllApexTests(this.path);
    this.eventsEmitter.on('Show Highlight', this.updateSelection);
  }

  public getHead(): TestNode {
    if (this.rootNode === null) {
      return this.getAllApexTests(this.path);
    }
    return this.rootNode;
  }

  public getChildren(element: TestNode): TestNode[] {
    if (element) {
      return element.children;
    } else {
      if (this.rootNode && this.rootNode.children.length > 0) {
        return this.rootNode.children;
      } else {
        let message = NO_TESTS_MESSAGE;
        let description = NO_TESTS_DESCRIPTION;
        if (!isLanguageClientReady()) {
          message = LOADING_MESSAGE;
          description = '';
        }
        const emptyArray = new Array<ApexTestNode>();
        const testToDisplay = new ApexTestNode(message, null);
        testToDisplay.description = description;
        emptyArray.push(testToDisplay);
        return emptyArray;
      }
    }
  }

  public getTreeItem(element: TestNode): vscode.TreeItem {
    if (element) {
      return element;
    } else {
      this.getAllApexTests(this.path);
      let message = NO_TESTS_MESSAGE;
      let description = NO_TESTS_DESCRIPTION;
      if (!isLanguageClientReady()) {
        message = LOADING_MESSAGE;
        description = '';
      }
      if (!(this.rootNode && this.rootNode.children.length > 0)) {
        this.rootNode = new ApexTestNode(message, null);
        const testToDisplay = new ApexTestNode(message, null);
        testToDisplay.description = description;
        this.rootNode.children.push(testToDisplay);
      }
      return this.rootNode;
    }
  }

  public async refresh() {
    this.rootNode = null; // Reset tests
    this.apexTestMap.clear();
    ApexTestOutlineProvider.testStrings.clear();
    this.apexTestInfo = null;
    if (isLanguageClientReady()) {
      this.apexTestInfo = await getApexTests();
    }
    this.getAllApexTests(this.path);
    this.onDidChangeTestData.fire();
  }

  private getAllApexTests(path: string): TestNode {
    if (this.rootNode == null) {
      // Starting Out
      this.rootNode = new ApexTestGroupNode('ApexTests', null);
    }
    // Check if lsp worked is ready
    if (this.apexTestInfo) {
      this.apexTestInfo.forEach(test => {
        let apexGroup = this.apexTestMap.get(
          test.definingType
        ) as ApexTestGroupNode;
        if (!apexGroup) {
          const groupLocation = new vscode.Location(
            test.location.uri,
            APEX_GROUP_RANGE
          );
          apexGroup = new ApexTestGroupNode(test.definingType, groupLocation);
          this.apexTestMap.set(test.definingType, apexGroup);
        }
        const apexTest = new ApexTestNode(test.methodName, test.location);
        apexTest.name = apexGroup.label + '.' + apexTest.label;
        this.apexTestMap.set(apexTest.name, apexTest);
        apexGroup.children.push(apexTest);
        if (
          this.rootNode &&
          !(this.rootNode.children.indexOf(apexGroup) >= 0)
        ) {
          this.rootNode.children.push(apexGroup);
        }
        ApexTestOutlineProvider.testStrings.add(apexGroup.name);
      });
    }
    return this.rootNode;
  }

  public async showErrorMessage(test: TestNode) {
    let position: vscode.Range | number = test.location!.range;
    if (test instanceof ApexTestNode) {
      const errorMessage = test.errorMessage;
      if (errorMessage && errorMessage !== '') {
        const stackTrace = test.stackTrace;
        position =
          parseInt(
            stackTrace.substring(
              stackTrace.indexOf('line') + 4,
              stackTrace.indexOf(',')
            ),
            10
          ) - 1; // Remove one because vscode location is zero based
        channelService.appendLine('-----------------------------------------');
        channelService.appendLine(stackTrace);
        channelService.appendLine(errorMessage);
        channelService.appendLine('-----------------------------------------');
        channelService.showChannelOutput();
      }
    }
    if (test.location) {
      vscode.window.showTextDocument(test.location.uri).then(() => {
        this.eventsEmitter.emit('Show Highlight', position);
      });
    }
  }

  public async runSingleTest(test: TestNode) {
    const tmpFolder = this.getTempFolder();
    const builder = new ReadableApexTestRunCodeActionExecutor(
      [test.name],
      false,
      tmpFolder
    );
    const commandlet = new SfdxCommandlet(
      new SfdxWorkspaceChecker(),
      new EmptyParametersGatherer(),
      builder
    );
    await commandlet.run();
  }

  public updateSelection(index: vscode.Range | number) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      if (index instanceof vscode.Range) {
        editor.selection = new vscode.Selection(index.start, index.end);
        editor.revealRange(index); // Show selection
      } else {
        const line = editor.document.lineAt(index);
        const startPos = new vscode.Position(
          line.lineNumber,
          line.firstNonWhitespaceCharacterIndex
        );
        editor.selection = new vscode.Selection(startPos, line.range.end);
        editor.revealRange(line.range); // Show selection
      }
    }
  }

  public getTempFolder(): string {
    return os.tmpdir();
  }

  public async runApexTests(): Promise<void> {
    await this.refresh();
    const tmpFolder = this.getTempFolder();
    const builder = new ReadableApexTestRunCodeActionExecutor(
      Array.from(ApexTestOutlineProvider.testStrings.values()),
      false,
      tmpFolder
    );
    const commandlet = new SfdxCommandlet(
      new SfdxWorkspaceChecker(),
      new EmptyParametersGatherer(),
      builder
    );
    await commandlet.run();
  }

  public readJSONFile(folderName: string) {
    const jsonSummary = this.getJSONFileOutput(folderName);
    this.UpdateTestsFromJSON(jsonSummary);
    this.onDidChangeTestData.fire();
  }

  private getJSONFileOutput(fullFolderName: string): FullTestResult {
    const files = fs.readdirSync(fullFolderName);
    let fileName = files[0];
    for (const file of files) {
      if (
        file !== 'test-result-codecoverage.json' &&
        ospath.extname(file) === '.json' &&
        file.startsWith('test-result')
      ) {
        fileName = file;
      }
    }
    fileName = ospath.join(fullFolderName, fileName);
    const output = fs.readFileSync(fileName).toString();
    fs.unlinkSync(fileName);
    const jsonSummary = JSON.parse(output) as FullTestResult;
    return jsonSummary;
  }

  private UpdateTestsFromJSON(jsonSummary: FullTestResult) {
    const groups = new Set<ApexTestGroupNode>();
    for (const testResult of jsonSummary.tests) {
      const apexGroupName = testResult.FullName.split('.')[0];
      const apexGroup = this.apexTestMap.get(
        apexGroupName
      ) as ApexTestGroupNode;
      // Check if new group, if so, set to pass
      if (apexGroup) {
        groups.add(apexGroup);
      }
      const apexTest = this.apexTestMap.get(
        testResult.FullName
      ) as ApexTestNode;
      if (apexTest) {
        apexTest.outcome = testResult.Outcome;
        apexTest.updateIcon();
        if (testResult.Outcome === 'Fail') {
          apexTest.errorMessage = testResult.Message;
          apexTest.stackTrace = testResult.StackTrace;
          apexTest.description =
            apexTest.stackTrace + '\n' + apexTest.errorMessage;
        }
      }
    }
    groups.forEach(group => {
      group.updatePassFailLabel();
      group.description = TestSummarizer.summarize(jsonSummary.summary, group);
    });
  }
}

export abstract class TestNode extends vscode.TreeItem {
  public children = new Array<TestNode>();
  public description: string;
  public name: string;
  public location: vscode.Location | null;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    location: vscode.Location | null
  ) {
    super(label, collapsibleState);
    this.location = location;
    this.description = label;
    this.name = label;
    this.command = {
      command: 'sfdx.force.test.view.showError',
      title: 'show error',
      arguments: [this]
    };
  }

  public iconPath = {
    light: LIGHT_BLUE_BUTTON,
    dark: DARK_BLUE_BUTTON
  };

  get tooltip(): string {
    return this.description;
  }

  public updateIcon(outcome: string) {
    if (outcome === 'Pass') {
      // Passed Test
      this.iconPath = {
        light: LIGHT_GREEN_BUTTON,
        dark: DARK_GREEN_BUTTON
      };
    } else if (outcome === 'Fail') {
      // Failed test
      this.iconPath = {
        light: LIGHT_RED_BUTTON,
        dark: DARK_RED_BUTTON
      };
    }
  }

  public abstract contextValue: string;
}

export class ApexTestGroupNode extends TestNode {
  public passing: number = 0;

  constructor(label: string, location: vscode.Location | null) {
    super(label, vscode.TreeItemCollapsibleState.Expanded, location);
  }

  public contextValue = 'apexTestGroup';

  public updatePassFailLabel() {
    this.passing = 0;
    this.children.forEach(child => {
      if ((child as ApexTestNode).outcome === 'Pass') {
        this.passing++;
      }
    });
    this.label =
      this.name + ' (' + this.passing + '/' + this.children.length + ')';
    if (this.passing === this.children.length) {
      this.updateIcon('Pass');
    } else {
      this.updateIcon('Fail');
    }
  }

  public updateIcon(outcome: string) {
    super.updateIcon(outcome);
    if (outcome === 'Pass') {
      this.children.forEach(child => {
        // Update all the children as well
        child.updateIcon(outcome);
      });
    }
  }
}

export class ApexTestNode extends TestNode {
  public errorMessage: string = '';
  public stackTrace: string = '';
  public outcome = 'Not Run';

  constructor(label: string, location: vscode.Location | null) {
    super(label, vscode.TreeItemCollapsibleState.None, location);
  }

  public updateIcon() {
    super.updateIcon(this.outcome);
    if (this.outcome === 'Pass') {
      this.errorMessage = '';
      this.errorMessage = '';
    }
  }

  public contextValue = 'apexTest';
}

export class ReadableApexTestRunCodeActionExecutor extends (ForceApexTestRunCodeActionExecutor as {
  new (test: string, shouldGetCodeCoverage: boolean): any;
}) {
  private outputToJson: string;

  public constructor(
    tests: string[],
    shouldGetCodeCoverage: boolean,
    outputToJson: string
  ) {
    super(tests.join(','), shouldGetCodeCoverage);
    this.outputToJson = outputToJson;
  }

  public build(data: {}): Command {
    this.builder = this.builder
      .withDescription(
        nls.localize('force_apex_test_run_codeAction_description_text')
      )
      .withArg('force:apex:test:run')
      .withFlag('--tests', this.test)
      .withFlag('--resultformat', 'human')
      .withFlag('--outputdir', this.outputToJson)
      .withFlag('--loglevel', 'error');

    if (this.shouldGetCodeCoverage) {
      this.builder = this.builder.withArg('--codecoverage');
    }
    return this.builder.build();
  }

  public execute(response: ContinueResponse<{}>) {
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;
    const execution = new CliCommandExecutor(this.build(response.data), {
      cwd: vscode.workspace.workspaceFolders![0].uri.path
    }).execute(cancellationToken);

    execution.processExitSubject.subscribe(() => {
      ApexTestOutlineProvider.getInstance().readJSONFile(this.outputToJson);
    });

    super.attachExecution(
      execution,
      cancellationTokenSource,
      cancellationToken
    );
  }
}
