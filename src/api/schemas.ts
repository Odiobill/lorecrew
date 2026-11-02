import { Type, type Static, type TSchema } from 'typebox';
const object=<T extends Record<string,TSchema>>(properties:T)=>Type.Object(properties,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:256});
const text=Type.String({minLength:1,maxLength:100_000,pattern:'\\S'});
export const JsonSchema=Type.Unknown();
export const EmptySchema=object({});
export const ErrorSchema=object({error:object({code:Type.String(),message:Type.String()})});
export const OkSchema=object({ok:Type.Boolean()});
export const LoginSchema=object({secret:Type.String({minLength:1,maxLength:512})});
export const AuthSessionSchema=object({id,csrfToken:Type.String(),expiresAt:Type.Number()});
export const TokenInputSchema=object({name:Type.String({minLength:1,maxLength:128}),scopes:Type.Array(Type.Union([Type.Literal('read'),Type.Literal('write')]),{minItems:1,maxItems:2,uniqueItems:true})});
export const TokenSchema=object({id,name:Type.String(),scopes:Type.Array(Type.String()),createdAt:Type.Number()});
export const CreatedTokenSchema=object({...TokenSchema.properties,token:Type.String()});
export const SessionInputSchema=object({agentId:id,projectId:Type.Optional(id)});
export const StopTaskResultSchema=object({quiescent:Type.Boolean(),reason:Type.Optional(Type.String())});
export const TaskInputSchema=object({projectId:id,leadAgentId:id,objective:text});
export const TextInputSchema=object({text});
export const SessionRefSchema=object({thinkingPreference:Type.Optional(Type.Union([object({kind:Type.Literal('default')}),object({kind:Type.Literal('explicit'),level:Type.String()})])),id,agentId:id,projectId:Type.Optional(id),workloadId:Type.Optional(id),instanceId:id,agentRevision:Type.String(),model:object({provider:Type.String(),modelId:Type.String()})});
const state=Type.Union(['pending','idle','running','waiting','waiting_decision','blocked','completed','cancelled','failed'].map(s=>Type.Literal(s)));
const ContentSchema=Type.Union([object({type:Type.Literal('text'),text:Type.String()}),object({type:Type.Literal('toolCall'),id,name:Type.String(),arguments:JsonSchema})]);
export const PublicMessageDataSchema=object({content:Type.Array(ContentSchema),toolCallId:Type.Optional(Type.String()),toolName:Type.Optional(Type.String()),isError:Type.Optional(Type.Boolean())});
const UsageCountersSchema=object({input:Type.Optional(Type.Number()),output:Type.Optional(Type.Number()),cacheRead:Type.Optional(Type.Number()),cacheWrite:Type.Optional(Type.Number()),totalTokens:Type.Optional(Type.Number()),cost:Type.Optional(object({input:Type.Optional(Type.Number()),output:Type.Optional(Type.Number()),cacheRead:Type.Optional(Type.Number()),cacheWrite:Type.Optional(Type.Number()),total:Type.Optional(Type.Number())}))});
export const UsageSchema=object({models:Type.Record(Type.String(),UsageCountersSchema),tools:Type.Record(Type.String(),UsageCountersSchema)});
export const HistorySchema=object({id,kind:Type.Union(['user','assistant','tool','decision','delegation'].map(s=>Type.Literal(s))),at:Type.String(),data:PublicMessageDataSchema});
export const SessionSnapshotSchema=object({createdAt:Type.Optional(Type.String()),updatedAt:Type.Optional(Type.String()),session:SessionRefSchema,status:state,messages:Type.Array(HistorySchema),tools:Type.Array(PublicMessageDataSchema),usage:UsageSchema,blockedReason:Type.Optional(Type.String()),stopState:Type.Optional(Type.Union([Type.Literal('requested'),Type.Literal('confirmed')]))});
export const TaskSchema=object({authority:Type.Optional(object({domainId:id,epoch:Type.Integer({minimum:1})})),id,projectId:id,generation:Type.Integer(),leadSessionId:Type.String(),executingSessionId:Type.String(),returnSessionId:Type.Optional(Type.String()),parentTaskId:Type.Optional(id),dependsOn:Type.Array(id),objective:Type.String(),deliverable:Type.String(),contextPaths:Type.Array(Type.String()),workspaceId:Type.String(),state,outcome:Type.Optional(JsonSchema),blockedReason:Type.Optional(Type.String()),agentId:id,temporaryIdentity:Type.Optional(object({id,sourceAgentId:id,parentTaskId:id}))});
export const DecisionSchema=object({id,taskId:id,question:Type.String(),recommendation:Type.String(),blockedTaskIds:Type.Array(id),state:Type.Union([Type.Literal('pending'),Type.Literal('answered')]),answer:Type.Optional(Type.String()),answerRequestId:Type.Optional(Type.String())});
export const ModelSchema=object({provider:Type.String(),modelId:Type.String(),name:Type.String(),supportedThinkingLevels:Type.Array(Type.Union(['off','minimal','low','medium','high','xhigh','max'].map(x=>Type.Literal(x)))),available:Type.Boolean()});
export const AgentSchema=object({id,name:Type.String(),personality:Type.String(),responsibilities:Type.Array(Type.String()),groups:Type.Array(Type.String()),model:object({provider:Type.String(),modelId:Type.String(),thinkingLevel:Type.Optional(Type.String())}),revision:Type.String()});
export const ProjectSchema=object({checkpoint:Type.Optional(object({manifestId:Type.String({pattern:'^[a-f0-9]{64}$'}),vaultManifestCommit:Type.String({pattern:'^[a-f0-9]{40,64}$'})})),projectId:id,repositoryKey:Type.String(),ownerId:id,generation:Type.Integer(),transitionId:id,instanceId:id});
export const InstanceSchema=object({instanceId:id,name:Type.String()});
export const EventSchema=object({seq:Type.Integer({minimum:1}),id,kind:Type.String(),at:Type.String(),data:JsonSchema});
export const ResetSchema=object({instanceId:id,seq:Type.Integer({minimum:0}),snapshot:Type.Literal('/api/v1/snapshot')});
/** Decoded SSE frames: regular data is AppEvent; reset has no id and requests snapshot refresh. */
export const SseMessageSchema=Type.Union([
  object({event:Type.String({not:{const:'reset'}}),id:Type.String({pattern:'^[1-9][0-9]*$'}),data:EventSchema}),
  object({event:Type.Literal('reset'),data:ResetSchema}),
]);
export type SseMessage=Static<typeof SseMessageSchema>;
export const SnapshotSchema=object({instanceId:id,name:Type.String(),seq:Type.Integer({minimum:0}),sessions:Type.Array(SessionSnapshotSchema),tasks:Type.Array(TaskSchema),decisions:Type.Array(DecisionSchema),projects:Type.Array(ProjectSchema),agents:Type.Array(AgentSchema),models:Type.Array(ModelSchema)});
export type SessionInput=Static<typeof SessionInputSchema>;
export type TaskInput=Static<typeof TaskInputSchema>;
export type TextInput=Static<typeof TextInputSchema>;
export type TokenInput=Static<typeof TokenInputSchema>;
export const SubmissionSchema=object({submissionId:id});
export const DiffSchema=object({diff:Type.String()});
export const BrowserSessionListSchema=Type.Array(object({id,createdAt:Type.Number(),expiresAt:Type.Number()}));
export const EvidenceStateSchema=Type.Union([Type.Literal('tentative'),Type.Literal('validated'),Type.Literal('contested')]);
export const SearchHitSchema=object({path:Type.String(),revision:Type.String(),title:Type.String(),description:Type.String(),evidenceState:EvidenceStateSchema,applicability:Type.Record(Type.String(),JsonSchema),sourcePaths:Type.Array(Type.String())});
export const KnowledgeSearchSchema=object({items:Type.Array(SearchHitSchema),nextCursor:Type.Optional(Type.String())});
export const SourceLinkSchema=object({path:Type.String(),available:Type.Boolean(),localOnly:Type.Optional(Type.Boolean())});
export const EvidenceDetailSchema=object({path:Type.String(),kind:Type.String(),outcome:Type.String(),claimIds:Type.Array(Type.String()),context:JsonSchema,at:Type.String(),rationale:Type.Optional(Type.String()),artifacts:Type.Array(SourceLinkSchema),appliesToCurrent:Type.Boolean()});
export const KnowledgeDocumentSchema=object({path:Type.String(),revision:Type.String(),title:Type.String(),body:Type.String(),type:Type.String(),evidenceState:EvidenceStateSchema,applicability:Type.Record(Type.String(),JsonSchema),claims:Type.Array(Type.String()),subjectHash:Type.String(),sources:Type.Array(SourceLinkSchema),evidence:Type.Array(EvidenceDetailSchema)});
export const SkillItemSchema=object({supersededBy:Type.Optional(Type.Array(Type.String())),qualifiedId:Type.String(),path:Type.String(),description:Type.String(),scope:Type.String(),status:Type.String(),revision:Type.String(),evidenceState:Type.Union([Type.Literal('tentative'),Type.Literal('validated')]),resources:Type.Array(SourceLinkSchema)});
export const SkillPageSchema=object({items:Type.Array(SkillItemSchema),nextCursor:Type.Optional(Type.String())});
export const SkillInspectionSchema=object({items:Type.Array(SkillItemSchema),history:Type.Array(SkillItemSchema),historyNextCursor:Type.Optional(Type.String()),pin:Type.Optional(object({sessionId:id,taskId:id,qualifiedId:id,path:Type.String(),status:Type.String(),revision:Type.String()})),activation:Type.Optional(object({proposalId:id,baseRevision:Type.Union([Type.String(),Type.Null()])}))});
export const SkillLoadInputSchema=object({sessionId:id,qualifiedId:id,revision:Type.Optional(Type.String()),trial:Type.Optional(Type.Boolean())});
export const LoadedSkillSchema=object({revision:Type.String(),body:Type.String(),resources:Type.Array(object({path:Type.String(),revision:Type.String(),metadata:Type.Record(Type.String(),JsonSchema),body:Type.String()}))});
export const SkillActivateInputSchema=object({proposalId:id,expectedActiveRevision:Type.Union([Type.String(),Type.Null()]),mode:Type.Literal('explicit_unvalidated')});
export const SkillRollbackInputSchema=object({qualifiedId:id,expectedActiveRevision:Type.String(),targetRevision:Type.String()});
export const RevisionSchema=object({revision:Type.String()});
export const LearningItemSchema=object({path:Type.String(),revision:Type.String(),type:Type.String(),title:Type.String(),state:Type.String(),sourcePaths:Type.Array(SourceLinkSchema),details:JsonSchema});
export const LearningPageSchema=object({items:Type.Array(LearningItemSchema),nextCursor:Type.Optional(Type.String())});
export const LearningReviewsSchema=object({items:Type.Array(LearningItemSchema),nextCursor:Type.Optional(Type.String()),curator:object({state:Type.String(),reason:Type.Optional(Type.String()),work:Type.Array(JsonSchema),errors:Type.Array(JsonSchema),usage:Type.Array(JsonSchema)})});
export { Type };
const nullableRevision=Type.Union([Type.String(),Type.Null()]);
export const ExpectedRevisionSchema=object({expectedRevision:Type.String()});
export const AgentEditSchema=object({id,name:Type.String({minLength:1}),personality:text,responsibilities:Type.Array(text),groups:Type.Array(id),model:AgentSchema.properties.model,expectedRevision:Type.String()});
export const GroupSchema=object({id,name:Type.String(),description:Type.String(),revision:Type.String()});
export const GroupEditSchema=object({id,name:text,description:text,expectedRevision:Type.String()});
// Creation IDs become filenames. Imported IDs retain the existing PUT contract.
const creationId=Type.String({minLength:1,maxLength:80,pattern:'^(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9]|index|log)$)[A-Za-z0-9][A-Za-z0-9_-]*$'});
export const AgentCreateSchema=object({id:creationId,name:text,personality:text,responsibilities:Type.Array(text),groups:Type.Array(id),model:AgentSchema.properties.model});
export const GroupCreateSchema=object({id:creationId,name:text,description:text});
export const BindingInputSchema=object({path:text,expectedRevision:nullableRevision});
export const ProviderInputSchema=object({credentialEnv:Type.String({pattern:'^[A-Za-z_][A-Za-z0-9_]*$'}),expectedRevision:Type.String()});
export const CompatibleSettingsSchema=object({baseUrl:Type.String({minLength:1,maxLength:2048}),modelId:Type.String({minLength:1,maxLength:256}),auth:Type.Union([Type.Literal('api_key'),Type.Literal('none')]),contextWindow:Type.Integer({minimum:1024,maximum:2_000_000}),maxTokens:Type.Integer({minimum:1,maximum:2_000_000})});
export const CompatibleInputSchema=object({...CompatibleSettingsSchema.properties,expectedRevision:Type.String()});
export const ProviderSchema=object({id,compatible:Type.Optional(CompatibleSettingsSchema),name:Type.String(),credentialEnv:Type.Optional(Type.String()),revision:Type.String(),available:Type.Boolean(),methods:Type.Array(object({type:Type.Union([Type.Literal('api_key'),Type.Literal('oauth')]),label:Type.String()}))});
export const ProviderLoginInputSchema=object({type:Type.Union([Type.Literal('api_key'),Type.Literal('oauth')])});
export const ProviderAnswerSchema=object({promptId:id,value:Type.String({maxLength:16384})});
export const ProviderLoginSchema=object({id,providerId:id,state:Type.Union([Type.Literal('pending'),Type.Literal('prompt'),Type.Literal('success'),Type.Literal('error'),Type.Literal('cancelled'),Type.Literal('expired')]),expiresAt:Type.Number(),message:Type.Optional(Type.String()),events:Type.Array(object({type:Type.Union([Type.Literal('info'),Type.Literal('auth_url'),Type.Literal('device_code'),Type.Literal('progress')]),message:Type.Optional(Type.String()),url:Type.Optional(Type.String()),userCode:Type.Optional(Type.String()),links:Type.Optional(Type.Array(object({url:Type.String(),label:Type.String()})))})),prompt:Type.Optional(object({id,type:Type.Union([Type.Literal('text'),Type.Literal('secret'),Type.Literal('select'),Type.Literal('manual_code')]),message:Type.String(),options:Type.Optional(Type.Array(object({id:Type.String(),label:Type.String()})))}))});
export const AssignmentInputSchema=object({agentId:id,expectedRevision:nullableRevision});
export const AssignmentViewSchema=object({pending:Type.Optional(object({agentId:id,expectedRevision:nullableRevision})),revision:nullableRevision,assignment:Type.Union([object({agentId:id,ownerId:id,generation:Type.Integer()}),Type.Null()]),status:JsonSchema});
export const ScheduleInputSchema=object({id,agentId:id,projectId:Type.Optional(id),cron:text,timeZone:text,instructions:text,enabled:Type.Boolean()});
export const ScheduleEditSchema=object({...ScheduleInputSchema.properties,expectedRevision:Type.String()});
export const ScheduleSchema=object({...ScheduleInputSchema.properties,revision:Type.String(),ownerId:id,overlap:Type.Literal('skip'),missed:Type.Literal('coalesce'),effectiveFrom:Type.String()});
export const ScheduleListSchema=object({items:Type.Array(object({schedule:ScheduleSchema,currentState:Type.String(),lastDiagnostic:Type.Optional(JsonSchema),occurrences:Type.Array(JsonSchema)}))});
export const RemoteTasksSchema=object({lastFetchAt:Type.Union([Type.String(),Type.Null()]),items:Type.Array(object({path:Type.String(),originId:id,taskId:id,sessionId:id,sequence:Type.Integer(),reportedAt:Type.String(),state:Type.String(),summary:Type.String(),agentId:Type.Optional(id)}))});
export const SyncViewSchema=object({status:JsonSchema,pending:Type.Array(JsonSchema),recovery:Type.Array(object({id,path:Type.String(),at:Type.String()}))});
export const HistoryListSchema=object({items:Type.Array(object({path:Type.String(),title:Type.String(),originId:Type.String(),body:Type.String()}))});
export const ClaimSchema=object({id,repositoryKey:text,title:text});
export const HandoffSchema=object({checkpointId:id,expectedGeneration:Type.Integer({minimum:1}),targetInstanceId:id});

const SetupChoicesSchema=object({preference:Type.Optional(Type.Union([Type.Literal('personal'),Type.Literal('coding')])),agentId:Type.Optional(id),additionalAgentIds:Type.Optional(Type.Array(id,{maxItems:10,uniqueItems:true})),groupId:Type.Optional(id),projectId:Type.Optional(id),sessionId:Type.Optional(id),completed:Type.Optional(Type.Boolean())});
// Only bounded operation keys belong here. Form payloads, credentials and drafts never do.
const SetupOperationsSchema=Type.Record(Type.String({pattern:'^(agent|additionalAgent|group|session|task|message|project|save)$'}),Type.String({minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'}),{maxProperties:8});
export const SetupSaveSchema=object({expectedRevision:nullableRevision,choices:SetupChoicesSchema,pendingOperations:Type.Optional(SetupOperationsSchema)});
export const SetupStateSchema=object({...SetupChoicesSchema.properties,version:Type.Literal(1),revision:Type.String(),additionalAgentIds:Type.Array(id),completed:Type.Boolean(),pendingOperations:SetupOperationsSchema});
export const SetupViewSchema=object({vault:object({path:Type.String(),kind:Type.Union(['new','configured','existing_incomplete'].map(x=>Type.Literal(x)))}),entry:Type.Union([Type.Literal('starter'),Type.Literal('workspace')]),state:Type.Union([SetupStateSchema,Type.Null()]),needsSetup:Type.Boolean(),readiness:object({model:Type.Union(['missing_model','missing_credential','unverified','verified','failed'].map(x=>Type.Literal(x))),verifiedAt:Type.Optional(Type.String()),sessionId:Type.Optional(id),project:Type.Union(['not_selected','ready','claimed_unbound','unavailable'].map(x=>Type.Literal(x))),fleetConfigured:Type.Boolean()})});
export const ProjectInspectionInputSchema=object({path:text});
export const ProjectInspectionSchema=object({path:Type.String(),kind:Type.Union([Type.Literal('git'),Type.Literal('directory')]),suggestedRepositoryKey:Type.Optional(Type.String())});
export const ProjectConnectionInputSchema=object({projectId:id,title:text,repositoryKey:text,path:text});
export const ProjectConnectionSchema=object({projectId:id,state:Type.Union([Type.Literal('ready'),Type.Literal('claimed_unbound')]),diagnostic:Type.Optional(Type.String())});

export const OwnershipSetupInputSchema=object({mode:Type.Union([Type.Literal('standalone'),Type.Literal('shared')]),remote:Type.Optional(text),expectedRevision:Type.String()});
export const OwnershipSetupViewSchema=object({state:Type.Union(['unconfigured','pending','ready'].map(x=>Type.Literal(x))),mode:Type.Optional(Type.Union(['standalone','shared','configured'].map(x=>Type.Literal(x)))),remote:Type.Optional(Type.String()),revision:Type.String()});
export const HostFolderInputSchema=object({path:Type.Optional(text),cursor:Type.Optional(Type.String({minLength:1,maxLength:255}))});
export const HostFolderListingSchema=object({path:Type.String(),parent:Type.Union([Type.String(),Type.Null()]),selectable:Type.Boolean(),items:Type.Array(object({name:Type.String(),path:Type.String()})),nextCursor:Type.Optional(Type.String())});
export const ProjectPreviewInputSchema=object({projectId:id,path:text,repositoryKey:Type.Optional(text)});
export const ProjectPreviewSchema=object({path:Type.String(),kind:Type.Union([Type.Literal('git'),Type.Literal('directory')]),repositoryKey:Type.String(),title:Type.String(),token:Type.String()});
export const ProjectWorkflowInputSchema=Type.Union([object({mode:Type.Literal('existing'),projectId:id,title:text,path:text,repositoryKey:text,previewToken:text}),object({mode:Type.Literal('new'),projectId:id,title:text,parentPath:text,folderName:text}),object({mode:Type.Literal('clone'),projectId:id,title:text,url:text,parentPath:text,folderName:text})]);
export const ProjectWorkflowResultSchema=object({...ProjectConnectionSchema.properties,title:Type.String(),path:Type.String(),repositoryKey:Type.String(),kind:Type.Union([Type.Literal('git'),Type.Literal('directory')]),reused:Type.Optional(Type.Boolean())});
export const ProjectResumeInputSchema=object({useExisting:Type.Optional(Type.Boolean())});
export const ProjectSetupOptionsSchema=object({ownership:OwnershipSetupViewSchema,defaultPath:Type.String(),projects:Type.Array(object({projectId:id,title:Type.String(),path:Type.Optional(Type.String()),repositoryKey:Type.String(),state:Type.Union(['ready','claimed_unbound','unavailable'].map(x=>Type.Literal(x)))})),pending:Type.Array(object({projectId:id,title:Type.String(),path:Type.String(),mode:Type.Union([Type.Literal('existing'),Type.Literal('new'),Type.Literal('clone')]),phase:Type.Union(['planned','folder','connecting','connected'].map(x=>Type.Literal(x))),canAdoptExisting:Type.Boolean(),diagnostic:Type.Optional(Type.String())}))});

export const SkillScopeTargetSchema=Type.Union([object({scope:Type.Literal('global')}),object({scope:Type.Union([Type.Literal('group'),Type.Literal('agent')]),scopeId:id})]);
export const SkillNativeMappingSchema=object({fromPath:text,originalTarget:text,vaultPath:text,expectedRevision:text});
export const SkillNativeDraftSchema=object({previewId:text,manifestHash:text,resourceMappings:Type.Array(SkillNativeMappingSchema,{maxItems:64})});
export const SkillDraftFieldsSchema=object({name:Type.String({minLength:1,maxLength:128}),description:text,body:text,target:SkillScopeTargetSchema,resources:Type.Array(text,{maxItems:64,uniqueItems:true}),expectedActiveRevision:nullableRevision,source:Type.Optional(object({path:text,revision:text})),nativeImport:Type.Optional(SkillNativeDraftSchema)});
export const SkillDraftInputSchema=object({...SkillDraftFieldsSchema.properties,authoringId:Type.String({format:'uuid'}),reviewId:text,reviewRevision:text});
export const SkillScopePreviewInputSchema=object({path:text,target:SkillScopeTargetSchema});
export const SkillScopeInputSchema=object({...SkillScopePreviewInputSchema.properties,expectedRevision:text,managementRevision:text});
export const SkillOperationResumeSchema=object({expectedOperationRevision:text});
export const SkillLocalImportSchema=object({markdown:text});

export const SkillSourceInputSchema=object({url:Type.String({minLength:1,maxLength:2048}),ref:Type.Optional(Type.String({maxLength:240})),path:Type.Optional(Type.String({maxLength:240}))});
export const SkillImportPreviewInputSchema=Type.Union([SkillLocalImportSchema,object({sourceId:text,skillPath:text})]);

export const InboxMarkerSchema=object({id,revision:Type.String({minLength:1,maxLength:256})});
export const InboxSeenSchema=object({items:Type.Array(InboxMarkerSchema)});
export const VaultChoiceSchema=Type.Union([object({kind:Type.Literal('default')}),object({kind:Type.Literal('clone'),url:text,parentPath:text,folderName:Type.String({minLength:1,maxLength:255})}),object({kind:Type.Literal('new'),parentPath:text,folderName:Type.String({minLength:1,maxLength:255})}),object({kind:Type.Literal('existing'),path:text})]);
export const VaultPreviewInputSchema=object({choice:VaultChoiceSchema});
export const VaultConfirmSchema=object({choice:VaultChoiceSchema,previewToken:text,expectedRevision:text});
export const VaultPreviewSchema=object({token:Type.String(),path:Type.String(),kind:Type.Union([Type.Literal('new'),Type.Literal('existing')]),revision:Type.String()});
export const StartupSchema=object({instanceId:id,phase:Type.Union([Type.Literal('vault_required'),Type.Literal('initializing'),Type.Literal('migration_required'),Type.Literal('ready')]),revision:Type.String(),defaultVaultDir:Type.String(),vaultDir:Type.Optional(Type.String()),diagnostic:Type.Optional(Type.String())});

export const AgentUseReadinessSchema=object({agentId:id,agentRevision:Type.String(),model:object({provider:Type.String(),modelId:Type.String(),thinkingLevel:Type.Optional(Type.String())}),state:Type.Union(['ready','missing_credentials','missing_provider_config','unknown_model','unsupported_thinking_level'].map(x=>Type.Literal(x))),reason:Type.Optional(Type.String())});

const AttentionOriginSchema=Type.Union([
 object({kind:Type.Literal('user_task'),rootTaskId:id}),object({kind:Type.Literal('schedule'),occurrenceId:id,scheduleId:id}),object({kind:Type.Literal('workload'),sessionId:id,workloadId:id}),object({kind:Type.Literal('conversation'),sessionId:id})]);
const InboxRefSchema=object({id:Type.String(),revision:Type.String()});
export const InboxResultSchema=object({...InboxRefSchema.properties,source:AttentionOriginSchema,title:Type.String(),content:JsonSchema,sourcePaths:Type.Array(Type.String())});
export const InboxItemSchema=object({...InboxRefSchema.properties,class:Type.Union([Type.Literal('action'),Type.Literal('result')]),kind:Type.Union(['decision','blocked','failed','completed','report','finding'].map(x=>Type.Literal(x))),title:Type.String(),href:Type.String(),source:Type.Union([AttentionOriginSchema,object({kind:Type.Literal('decision'),decisionId:id,taskId:id}),object({kind:Type.Literal('repository'),repositoryKind:Type.Union([Type.Literal('vault'),Type.Literal('project')]),repositoryId:id,problemId:id})])});
export const InboxSchema=object({items:Type.Array(InboxItemSchema),count:Type.Integer({minimum:0})});
export const SessionResultsSchema=Type.Array(object({...InboxRefSchema.properties,title:Type.String(),kind:Type.Union(['completed','failed','report','finding'].map(x=>Type.Literal(x))),href:Type.String()}));

export const ProjectSelectionSchema=Type.Union([
 object({mode:Type.Literal('new'),projectId:id,title:text,parentPath:text,folderName:id}),
 object({mode:Type.Literal('existing'),projectId:id,title:text,path:text,catalogProjectId:Type.Optional(id),acknowledgeOpaque:Type.Optional(Type.Boolean())}),
 object({mode:Type.Literal('catalog-clone'),projectId:id,url:text,parentPath:text,folderName:id,acknowledgeOpaque:Type.Optional(Type.Boolean())}),
]);
export const ProjectFlowPreviewInputSchema=object({operationId:id,selection:ProjectSelectionSchema});
export const ProjectFlowConfirmInputSchema=object({selection:ProjectSelectionSchema,expectedPreviewRevision:id});
