
import * as vscode from 'vscode';
import COBOLSourceScanner, { SharedSourceReferences } from './cobolsourcescanner';
import { CodeActionProvider, CodeAction } from 'vscode';
import { isSupportedLanguage, TextLanguage } from './margindecorations';
import { ICOBOLSettings } from './iconfiguration';
import VSQuickCOBOLParse from './vscobolscanner';

function makeRegex(partialRegEx: string): RegExp | undefined {
    try {
        return new RegExp("^" + partialRegEx + "$", "i");
    }
    catch {
        return undefined;
    }
}

export class CobolLinterActionFixer implements CodeActionProvider {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        const codeActions: CodeAction[] = [];
        for (const diagnostic of context.diagnostics) {
            if (diagnostic.code === undefined) {
                continue;
            }

            // is it ours?
            if (diagnostic.code.toString().startsWith(CobolLinterProvider.NotReferencedMarker_internal) === true) {
                const startOfline = document.offsetAt(new vscode.Position(diagnostic.range.start.line, 0));
                const insertCode = diagnostic.code.toString().replace(CobolLinterProvider.NotReferencedMarker_internal, CobolLinterProvider.NotReferencedMarker_external);
                codeActions.push({
                    title: `Add COBOL lint ignore comment for '${diagnostic.message}'`,
                    diagnostics: [diagnostic],
                    command: {
                        title: 'Add COBOL lint comment to ignore the warning',
                        command: "cobolplugin.insertIgnoreCommentLine",
                        arguments: [document.uri, startOfline, insertCode],
                    },
                    kind: vscode.CodeActionKind.QuickFix,
                });
            }
        }
        return codeActions;
    }

    public async insertIgnoreCommentLine(docUri: vscode.Uri, offset: number, code: string):Promise<void> {
        await vscode.window.showTextDocument(docUri);
        const w = vscode.window.activeTextEditor;

        if (w !== undefined && code !== undefined) {
            const pos = w.document.positionAt(offset);
            w.edit(edit => {
                edit.insert(pos, "      *> cobol-lint " + code + "\n");
            });
        }
    }
}

export class CobolLinterProvider {
    private settings: ICOBOLSettings;

    private collection: vscode.DiagnosticCollection;
    private linterSev: vscode.DiagnosticSeverity;

    private current?: COBOLSourceScanner;
    private currentVersion?: number;
    private sourceRefs?: SharedSourceReferences;

    constructor(collection: vscode.DiagnosticCollection, settings: ICOBOLSettings) {
        this.collection = collection;
        this.settings = settings;
        this.linterSev = settings.linter_mark_as_information ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Hint;
    }

    public static NotReferencedMarker_internal = "COBOL_NOT_REF";
    public static NotReferencedMarker_external = "ignore";

    public async updateLinter(document: vscode.TextDocument): Promise<void> {

        if (this.settings.linter === false) {
            this.collection.clear();
            return;
        }

        /* drop out if not COBOL */
        if (isSupportedLanguage(document) !== TextLanguage.COBOL) {
            return;
        }

        /* has it changed? */
        if (this.setupCOBOLQuickParse(document) === false) {
            return;
        }

        if (this.sourceRefs === undefined || this.current === undefined) {
            return;
        }

        const qp: COBOLSourceScanner = this.current;

        const diagRefs = new Map<string, vscode.Diagnostic[]>();
        this.collection.clear();

        if (qp.sourceIsCopybook) {
            return;
        }

        this.linterSev = this.settings.linter_mark_as_information ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Hint;

        if (qp.configHandler.linter_unused_paragraphs_or_sections) {
            this.processParsedDocumentForUnusedSymbols(qp, diagRefs);
        }

        if (qp.configHandler.linter_house_standards_rules) {
            this.processParsedDocumentForStandards(qp, diagRefs);
        }

        for (const [f, value] of diagRefs) {
            const u = vscode.Uri.file(f);
            this.collection.set(u, value);
        }
    }

    private processParsedDocumentForStandards(qp: COBOLSourceScanner, diagRefs: Map<string, vscode.Diagnostic[]>) {

        if (this.sourceRefs === undefined) {
            return;
        }

        const standards: string[] = qp.configHandler.linter_house_standards_rules;
        const standardsMap = new Map<string, string>();
        const ruleRegexMap = new Map<string, RegExp>();

        for (const standard of standards) {
            const sectionStandard = standard.split("=", 2);
            standardsMap.set(sectionStandard[0].toLocaleLowerCase(), sectionStandard[1]);
        }

        for (const [key, tokens] of qp.constantsOrVariables) {
            for (const token of tokens) {
                if (token.tokenNameLower === "filler") {
                    continue;
                }

                const rule = standardsMap.get(token.inSection.tokenNameLower);
                if (rule !== undefined) {
                    let regexForRule = ruleRegexMap.get(token.inSection.tokenNameLower);
                    if (regexForRule === undefined) {
                        regexForRule = makeRegex(rule);
                        if (regexForRule === undefined) {
                            continue;
                        }
                        ruleRegexMap.set(token.inSection.tokenNameLower, regexForRule);
                    }
                    if (regexForRule.test(token.tokenName) === false) {
                        const r = new vscode.Range(new vscode.Position(token.startLine, token.startColumn),
                            new vscode.Position(token.startLine, token.startColumn + token.tokenName.length));

                        const d = new vscode.Diagnostic(r, key + ' breaks house standards rule for ' + token.inSection.tokenNameLower + " section", this.linterSev);
                        d.tags = [vscode.DiagnosticTag.Unnecessary];

                        if (diagRefs.has(token.filename)) {
                            const arr = diagRefs.get(token.filename);
                            if (arr !== undefined) {
                                arr.push(d);
                            }
                        } else {
                            const arr: vscode.Diagnostic[] = [];
                            arr.push(d);
                            diagRefs.set(token.filename, arr);
                        }

                    }

                }
            }
        }
    }

    private processParsedDocumentForUnusedSymbols(qp: COBOLSourceScanner, diagRefs: Map<string, vscode.Diagnostic[]>) {

        if (this.sourceRefs === undefined) {
            return;
        }

        const sourceRefs: SharedSourceReferences = this.sourceRefs;

        for (const [key, token] of qp.paragraphs) {
            const workLower = key.toLowerCase();
            if (sourceRefs.ignoreUnusedSymbol.has(workLower)) {
                continue;
            }
            if (sourceRefs.targetReferences.has(workLower) === false) {
                const r = new vscode.Range(new vscode.Position(token.startLine, token.startColumn),
                    new vscode.Position(token.startLine, token.startColumn + token.tokenName.length));
                const d = new vscode.Diagnostic(r, key + ' paragraph is not referenced', this.linterSev);
                d.tags = [vscode.DiagnosticTag.Unnecessary];
                d.code = CobolLinterProvider.NotReferencedMarker_internal + " " + key;

                if (diagRefs.has(token.filename)) {
                    const arr = diagRefs.get(token.filename);
                    if (arr !== undefined) {
                        arr.push(d);
                    }
                } else {
                    const arr: vscode.Diagnostic[] = [];
                    arr.push(d);
                    diagRefs.set(token.filename, arr);
                }
            }
        }

        for (const [key, token] of qp.sections) {
            const workLower = key.toLowerCase();

            if (sourceRefs.ignoreUnusedSymbol.has(workLower)) {
                continue;
            }

            if (token.inProcedureDivision) {
                if (sourceRefs.targetReferences.has(workLower) === false) {
                    const r = new vscode.Range(new vscode.Position(token.startLine, token.startColumn),
                        new vscode.Position(token.startLine, token.startColumn + token.tokenName.length));
                    const d = new vscode.Diagnostic(r, key + ' section is not referenced', this.linterSev);
                    d.code = CobolLinterProvider.NotReferencedMarker_internal + " " + key;
                    d.tags = [vscode.DiagnosticTag.Unnecessary];

                    if (diagRefs.has(token.filename)) {
                        const arr = diagRefs.get(token.filename);
                        if (arr !== undefined) {
                            arr.push(d);
                        }
                    } else {
                        const arr: vscode.Diagnostic[] = [];
                        arr.push(d);
                        diagRefs.set(token.filename, arr);
                    }
                }
            }
        }
    }

    private setupCOBOLQuickParse(document: vscode.TextDocument): boolean {
        if (this.current !== undefined && this.current.filename !== document.fileName) {
            this.current = undefined;
        }

        // cache current document, interatives search to be faster
        if (this.current === undefined || this.currentVersion !== document.version) {
            this.current = VSQuickCOBOLParse.getCachedObject(document);
            this.sourceRefs = this.current?.sourceReferences;
            this.currentVersion = document.version;
            return true;
        }

        return false;
    }


}