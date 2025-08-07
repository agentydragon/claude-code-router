/**
 * System Message Search-Replace Transformer
 * 
 * This transformer performs search-replace operations on system messages.
 * It can be used to modify system prompts, rebrand messages, or adapt
 * prompts for different providers.
 */
export class SystemMessageTransformer {
  name = 'system-replace';
  private searchPattern: string | RegExp;
  private replaceValue: string;
  
  constructor(options: { search?: string; replace?: string; regex?: boolean } = {}) {
    // Default example: Replace "Claude Code" with "AI Assistant"
    const search = options.search || 'Claude Code';
    const replace = options.replace || 'AI Assistant';
    
    // Support regex patterns if specified
    if (options.regex) {
      this.searchPattern = new RegExp(search, 'g');
    } else {
      // Escape special regex characters for literal string search
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      this.searchPattern = new RegExp(escaped, 'g');
    }
    
    this.replaceValue = replace;
  }
  
  /**
   * Transform outbound request - modify system messages
   */
  transformRequestOut(request: any): any {
    // Clone the request to avoid mutating the original
    const modifiedRequest = JSON.parse(JSON.stringify(request));
    
    // Process system field (can be string or array)
    if (modifiedRequest.system) {
      modifiedRequest.system = this.processSystemField(modifiedRequest.system);
    }
    
    // Process messages array - look for system role messages
    if (Array.isArray(modifiedRequest.messages)) {
      modifiedRequest.messages = modifiedRequest.messages.map((message: any) => {
        if (message.role === 'system') {
          return {
            ...message,
            content: this.replaceInContent(message.content)
          };
        }
        return message;
      });
    }
    
    return modifiedRequest;
  }
  
  /**
   * Process the system field which can be string or array
   */
  private processSystemField(system: any): any {
    if (typeof system === 'string') {
      // Simple string system message
      return this.replaceInContent(system);
    }
    
    if (Array.isArray(system)) {
      // Array of system messages (Anthropic format)
      return system.map((item: any) => {
        if (item.type === 'text' && item.text) {
          return {
            ...item,
            text: this.replaceInContent(item.text)
          };
        }
        return item;
      });
    }
    
    return system;
  }
  
  /**
   * Perform the actual search-replace operation
   */
  private replaceInContent(content: string): string {
    if (typeof content !== 'string') return content;
    return content.replace(this.searchPattern, this.replaceValue);
  }
}

/**
 * Example: Pre-configured transformer for replacing "Claude Code" with "OpenAI Code"
 */
export class ClaudeToOpenAITransformer extends SystemMessageTransformer {
  constructor() {
    super({
      search: 'Claude Code',
      replace: 'OpenAI Code'
    });
    this.name = 'claude-to-openai';
  }
}