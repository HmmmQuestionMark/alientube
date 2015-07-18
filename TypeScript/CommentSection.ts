/// <reference path="index.ts" />
/**
    * Namespace for All AlienTube operations.
    * @namespace AlienTube
*/
"use strict";
module AlienTube {
    /**
        * Starts a new instance of the AlienTube comment section and adds it to DOM.
        * @class CommentSection
        * @param currentVideoIdentifier YouTube Video query identifier.
    */
    export class CommentSection {
        template: HTMLDocument;
        threadCollection: Array<any>;
        storedTabCollection: Array<any>;
        userIsSignedIn: boolean;

        constructor(currentVideoIdentifier: string) {
            var templateLink, loadingScreen, videoSearchString;

            this.threadCollection = new Array();
            this.storedTabCollection = new Array();

            // Make sure video identifier is not null. If it is null we are not on a video page so we will just time out.
            if (currentVideoIdentifier) {
                // Load the html5 template file from disk and wait for it to load.
                templateLink = document.createElement("link");
                templateLink.id = "alientubeTemplate";
                Application.getExtensionTemplates((templateContainer) => {
                    this.template = templateContainer;

                    // Set Loading Screen
                    loadingScreen = new LoadingScreen(this, LoadingState.LOADING, Application.localisationManager.get("loading_search_message"));
                    this.set(loadingScreen.HTMLElement);

                    // Open a search request to Reddit for the video identfiier
                    videoSearchString = encodeURI(`(url:3D${currentVideoIdentifier} OR url:${currentVideoIdentifier}) (site:youtube.com OR site:youtu.be)`);
                    new AlienTube.Reddit.Request("https://api.reddit.com/search.json?q=" + videoSearchString, RequestType.GET, (results) => {
                        var searchResults, finalResultCollection, preferredPost, preferredSubreddit, commentLinks, getExcludedSubreddits, sortedResultCollection;
                        var tabContainer, tabContainerTemplate, ApplicationContainer, linkElement, url, match;
                        var mRegex = /(?:http|https):\/\/(.[^/]+)\/r\/([A-Za-z0-9][A-Za-z0-9_]{2,20})(?:\/comments\/)?([A-Za-z0-9]*)/g;

                        // There are a number of ways the Reddit API can arbitrarily explode, here are some of them.
                        if (results === {} || results.kind !== 'Listing' || results.data.children.length === 0) {
                            this.returnNoResults();
                        } else {
                            searchResults = results.data.children;
                            finalResultCollection = [];

                            /* Filter out Reddit threads that do not lead to the video. Additionally, remove ones that have passed the 6
                            month threshold for Reddit posts and are in preserved mode, but does not have any comments. */
                            searchResults.forEach(function(result) {
                                if (CommentSection.validateItemFromResultSet(result.data, currentVideoIdentifier)) {
                                    finalResultCollection.push(result.data);
                                }
                            });

                            if (finalResultCollection.length > 0) {
                                /* Scan the YouTube comment sections for references to subreddits or reddit threads.
                                These will be prioritised and loaded first.  */
                                commentLinks = document.querySelectorAll("#eow-description a");
                                for (var b = 0, coLen = commentLinks.length; b < coLen; b += 1) {
                                    linkElement = <HTMLElement>commentLinks[b];
                                    url = linkElement.getAttribute("href");
                                    if (typeof (url) !== 'undefined') {
                                        match = mRegex.exec(url);
                                        if (match) {
                                            preferredSubreddit = match[2];
                                            if (match[3].length > 0) preferredPost = match[3];
                                            break;
                                        }
                                    }
                                }
    	                       
                                // Sort threads into array groups by what subreddit they are in.
                                getExcludedSubreddits = Preferences.enforcedExludedSubreddits.concat(Preferences.getArray("excludedSubredditsSelectedByUser"));
                                sortedResultCollection = {};
                                finalResultCollection.forEach(function(thread) {
                                    if (getExcludedSubreddits.indexOf(thread.subreddit.toLowerCase()) !== -1) return;
                                    if (thread.score < Preferences.getNumber("hiddenPostScoreThreshold")) return;

                                    if (!sortedResultCollection.hasOwnProperty(thread.subreddit)) sortedResultCollection[thread.subreddit] = [];
                                    sortedResultCollection[thread.subreddit].push(thread);
                                });

                                // Sort posts into collections by what subreddit they appear in.
                                this.threadCollection = [];
                                for (var subreddit in sortedResultCollection) {
                                    if (sortedResultCollection.hasOwnProperty(subreddit)) {
                                        this.threadCollection.push(sortedResultCollection[subreddit].reduce((a, b) => {
                                            return ((this.getConfidenceForRedditThread(b) - this.getConfidenceForRedditThread(a)) || b.id === preferredPost) ? a : b;
                                        }));
                                    }
                                }

                                if (this.threadCollection.length > 0) {
                                    // Sort subreddits so there is only one post per subreddit, and that any subreddit or post that is linked to in the description appears first.
                                    this.threadCollection.sort((a, b) => {
                                        return this.getConfidenceForRedditThread(b) - this.getConfidenceForRedditThread(a);
                                    });
                                    
                                    for (var i = 0, len = this.threadCollection.length; i < len; i += 1) {
                                        if (this.threadCollection[i].subreddit === preferredSubreddit) {
                                            var threadDataForFirstTab = this.threadCollection[i];
                                            this.threadCollection.splice(i, 1);
                                            this.threadCollection.splice(0, 0, threadDataForFirstTab);
                                            break;
                                        }
                                    }

                                    // Generate tabs.
                                    tabContainerTemplate = Application.getExtensionTemplateItem(this.template, "tabcontainer");
                                    tabContainer = <HTMLDivElement> tabContainerTemplate.querySelector("#at_tabcontainer");
                                    this.insertTabsIntoDocument(tabContainer, 0);
                                    window.addEventListener("resize", this.updateTabsToFitToBoundingContainer.bind(this), false);

                                    ApplicationContainer = this.set(tabContainer);
                                    ApplicationContainer.appendChild(tabContainerTemplate.querySelector("#at_comments"));

                                    // If the selected post is prioritised, marked it as such
                                    if (this.threadCollection[0].id === preferredPost || this.threadCollection[0].subreddit === preferredSubreddit) {
                                        this.threadCollection[0].official = true;
                                    }

                                    // Load the first tab.
                                    this.downloadThread(this.threadCollection[0]);
                                    return;
                                }
                            }
                            this.returnNoResults();
                        }
                    }, null, loadingScreen);
                });
            }
        }

        /**
            * Display a tab in the comment section, if it is locally cached, use that, if not, download it.
            * @param threadData Data about the thread to download from a Reddit search page.
            * @private
        */
        private showTab(threadData: any) {
            var getTabById = this.storedTabCollection.filter(function(x) {
                return x[0].data.children[0].data.name === threadData.name;
            });
            if (getTabById.length > 0) {
                new CommentThread(getTabById[0], this)
            } else {
                this.downloadThread(threadData);
            }
        }

        /**
            * Download a thread from Reddit.
            * @param threadData Data about the thread to download from a Reddit search page.
        */
        public downloadThread(threadData: any) {
            var loadingScreen = new LoadingScreen(this, LoadingState.LOADING, Application.localisationManager.get("loading_post_message"));
            var alientubeCommentContainer = document.getElementById("at_comments");
            while (alientubeCommentContainer.firstChild) {
                alientubeCommentContainer.removeChild(alientubeCommentContainer.firstChild);
            }
            alientubeCommentContainer.appendChild(loadingScreen.HTMLElement);

            var requestUrl = `https://api.reddit.com/r/${threadData.subreddit}/comments/${threadData.id}.json?sort=${Preferences.getString("threadSortType")}`;
            new AlienTube.Reddit.Request(requestUrl, RequestType.GET, (responseObject) => {
                // Remove previous tab from memory if preference is unchecked; will require a download on tab switch.
                responseObject[0].data.children[0].data.official = threadData.official;

                new CommentThread(responseObject, this);
                this.storedTabCollection.push(responseObject);
            }, null, loadingScreen);
        }

        /**
            * Sets the contents of the comment section.
            * @param contents HTML DOM node or element to use.
        */
        public set(contents: Node) {
            var bodyBackgroundColor, bodyBackgroundColorArray, bodyBackgroundColorAverage, redditButton, redditText, redditButtonTemplate;

            var redditContainer = document.createElement("section");
            redditContainer.id = "alientube";

            var commentsContainer = document.getElementById("watch7-content");
            var previousRedditInstance = document.getElementById("alientube");
            var googlePlusContainer = document.getElementById("watch-discussion");
            if (previousRedditInstance) {
                commentsContainer.removeChild(previousRedditInstance);
            }


            /* Check if Dark Mode is activated, and set AlienTube to dark mode */
            bodyBackgroundColor = window.getComputedStyle(document.body, null).getPropertyValue('background-color');
            bodyBackgroundColorArray = bodyBackgroundColor.substring(4, bodyBackgroundColor.length - 1).replace(/ /g, '').split(',');
            bodyBackgroundColorAverage = 0;
            for (var i = 0; i < 3; i += 1) {
                bodyBackgroundColorAverage = bodyBackgroundColorAverage + parseInt(bodyBackgroundColorArray[i], 10);
            }
            bodyBackgroundColorAverage = bodyBackgroundColorAverage / 3;
            if (bodyBackgroundColorAverage < 100) {
                document.body.classList.add("darkmode");
            }

            if (googlePlusContainer) {
                /* Add the "switch to Reddit" button in the google+ comment section */
                redditButton = <HTMLDivElement> document.getElementById("at_switchtoreddit");
                if (!redditButton) {
                    redditButtonTemplate = Application.getExtensionTemplateItem(this.template, "switchtoreddit");
                    redditButton = <HTMLDivElement> redditButtonTemplate.querySelector("#at_switchtoreddit");
                    redditText = <HTMLSpanElement> redditButton.querySelector("#at_reddittext");
                    redditText.textContent = Application.localisationManager.get("post_button_comments");
                    redditButton.addEventListener("click", this.onRedditClick, true);
                    googlePlusContainer.parentNode.insertBefore(redditButton, googlePlusContainer);
                }

                if (this.getDisplayActionForCurrentChannel() === "gplus") {
                    redditContainer.style.display = "none"
                    redditButton.style.display = "block";
                } else {
                    googlePlusContainer.style.display = "none";
                }
            }
            
            /* Set the setting for whether or not AlienTube should show itself on this YouTube channel */
            var allowOnChannelContainer = document.getElementById("allowOnChannelContainer");
            if (!allowOnChannelContainer) {
                var youTubeActionsContainer = document.getElementById("watch7-user-header");
                var allowOnChannel = Application.getExtensionTemplateItem(this.template, "allowonchannel");
                allowOnChannel.children[0].appendChild(document.createTextNode("Show AlienTube on this channel"));
                var allowOnChannelCheckbox = allowOnChannel.querySelector("#allowonchannel");
                allowOnChannelCheckbox.checked = (this.getDisplayActionForCurrentChannel() === "alientube");
                allowOnChannelCheckbox.addEventListener("change", this.allowOnChannelChange, false);
                youTubeActionsContainer.appendChild(allowOnChannel);
            }

            /* Add AlienTube contents */
            redditContainer.appendChild(contents);
            commentsContainer.appendChild(redditContainer);
            return redditContainer;
        }

        /**
            * Validate a Reddit search result set and ensure the link urls go to the correct address.
            * This is done due to the Reddit search result being extremely unrealiable, and providing mismatches.

            * Additionally, remove ones that have passed the 6 month threshold for Reddit posts and are in preserved mode,
            * but does not have any comments.

            * @param itemFromResultSet An object from the reddit search result array.
            * @param currentVideoIdentifier A YouTube video identifier to compare to.
            * @returns A boolean indicating whether the item is actually for the current video.
            * @private
        */
        private static validateItemFromResultSet(itemFromResultSet: any, currentVideoIdentifier: string): Boolean {
            var urlSearch, requestItems, requestPair, component, shareRequestPair, shareRequestItems, urlSearch, obj;

            if (itemFromResultSet.isRedditPreservedPost() && itemFromResultSet.num_comments < 1) {
                return false;
            }

            if (itemFromResultSet.domain === "youtube.com") {
                // For urls based on the full youtube.com domain, retrieve the value of the "v" query parameter and compare it.
                urlSearch = itemFromResultSet.url.substring(itemFromResultSet.url.indexOf("?") + 1);
                requestItems = urlSearch.split('&');
                for (var i = 0, len = requestItems.length; i < len; i += 1) {
                    var requestPair = requestItems[i].split("=");
                    if (requestPair[0] === "v" && requestPair[1] === currentVideoIdentifier) {
                        return true;
                    }
                    if (requestPair[0] === "amp;u") {
                        component = decodeURIComponent(requestPair[1]);
                        component = component.replace("/watch?", "");
                        var shareRequestItems = component.split('&');
                        for (var j = 0, slen = shareRequestItems.length; j < slen; j += 1) {
                            var shareRequestPair = shareRequestItems[j].split("=");
                            if (shareRequestPair[0] === "v" && shareRequestPair[1] === currentVideoIdentifier) {
                                return true;
                            }
                        }
                    }
                }
            } else if (itemFromResultSet.domain === "youtu.be") {
                // For urls based on the shortened youtu.be domain, retrieve everything the path after the domain and compare it.
                urlSearch = itemFromResultSet.url.substring(itemFromResultSet.url.lastIndexOf("/") + 1);
                obj = urlSearch.split('?');
                if (obj[0] === currentVideoIdentifier) {
                    return true;
                }
            }
            return false;
        }

        /**
            * Insert tabs to the document calculating the width of tabs and determine how many you can fit without breaking the
            * bounds of the comment section.

            * @param tabContainer The tab container to operate on.
            * @param [selectTabAtIndex] The tab to be in active / selected status.
        */
        public insertTabsIntoDocument(tabContainer: HTMLElement, selectTabAtIndex?: number) {
            var overflowContainer = <HTMLDivElement> tabContainer.querySelector("#at_overflow");
            var len = this.threadCollection.length;
            var maxWidth = document.getElementById("watch7-content").offsetWidth - 80;
            var width = (21 + this.threadCollection[0].subreddit.length * 7);
            var i = 0;
            var tab, tabLink, overflowContainerMenu, menuItem, itemName, selectedTab;

            /* Calculate the width of tabs and determine how many you can fit without breaking the bounds of the comment section. */
            if (len > 0) {
                for (i = 0; i < len; i += 1) {
                    width = width + (21 + (this.threadCollection[i].subreddit.length * 7));
                    if (width >= maxWidth) {
                        break;
                    }
                    tab = document.createElement("button");
                    tab.className = "at_tab";
                    tab.setAttribute("data-value", this.threadCollection[i].subreddit);
                    tabLink = document.createElement("a");
                    tabLink.textContent = this.threadCollection[i].subreddit;
                    tabLink.setAttribute("href", "http://reddit.com/r/" + this.threadCollection[i].subreddit);
                    tabLink.setAttribute("target", "_blank");
                    tab.addEventListener("click", this.onSubredditTabClick.bind(this), false);
                    tab.appendChild(tabLink);
                    tabContainer.insertBefore(tab, overflowContainer);
                }

                // We can't fit any more tabs. We will now start populating the overflow menu.
                if (i < len) {
                    overflowContainer.style.display = "block";

                    /* Click handler for the overflow menu button, displays the overflow menu. */
                    overflowContainer.addEventListener("click", () => {
                        overflowContainerMenu = <HTMLUListElement> overflowContainer.querySelector("ul");
                        overflowContainer.classList.add("show");
                    }, false);

                    /* Document body click handler that closes the overflow menu when the user clicks outside of it.
                    by defining event bubbling in the third argument we are preventing clicks on the menu from triggering this event */
                    document.body.addEventListener("click", () => {
                        overflowContainerMenu = <HTMLUListElement> overflowContainer.querySelector("ul");
                        overflowContainer.classList.remove("show");
                    }, true);

                    /* Continue iterating through the items we couldn't fit into tabs and populate the overflow menu. */
                    for (i = i; i < len; i += 1) {
                        menuItem = document.createElement("li");
                        menuItem.setAttribute("data-value", this.threadCollection[i].subreddit);
                        menuItem.addEventListener("click", this.onSubredditOverflowItemClick.bind(this), false);
                        itemName = document.createTextNode(this.threadCollection[i].subreddit);
                        menuItem.appendChild(itemName);
                        overflowContainer.children[1].appendChild(menuItem);
                    }
                } else {
                    /* If we didn't need the overflow menu there is no reason to show it. */
                    overflowContainer.style.display = "none";
                }
            } else {
                overflowContainer.style.display = "none";
            }

            // Set the active tab if provided
            if (selectTabAtIndex != null) {
                selectedTab = <HTMLButtonElement>tabContainer.children[selectTabAtIndex];
                selectedTab.classList.add("active");
            }
        }

        /**
            * Set the comment section to the "No Results" page.
            * @private
        */
        private returnNoResults() {
            var template, message, googlePlusText, googlePlusButton, googlePlusContainer, redditButton;

            template = Application.getExtensionTemplateItem(this.template, "noposts");
            message = template.querySelector(".single_line");
            message.textContent = Application.localisationManager.get("post_label_noresults");

            /* Set the icon, text, and event listener for the button to switch to the Google+ comments. */
            googlePlusButton = template.querySelector("#at_switchtogplus");
            googlePlusText = <HTMLSpanElement> googlePlusButton.querySelector("#at_gplustext");
            googlePlusText.textContent = Application.localisationManager.get("post_button_comments");
            googlePlusButton.addEventListener("click", this.onGooglePlusClick, false);
            
            if (Preferences.getBoolean("showGooglePlusButton") === false ||  googlePlusContainer === null) {
                googlePlusButton.style.display = "none";
            }

            this.set(template);

            googlePlusContainer = document.getElementById("watch-discussion");

            if (Preferences.getBoolean("showGooglePlusWhenNoPosts") && googlePlusContainer) {
                googlePlusContainer.style.display = "block";
                document.getElementById("alientube").style.display = "none";

                redditButton = <HTMLDivElement> document.getElementById("at_switchtoreddit");
                if (redditButton) {
                    redditButton.classList.add("noresults");
                    document.getElementById("at_reddittext").textContent = Application.localisationManager.get("post_label_noresults");
                }
            }
        }
    	
        /**
         * Switch to the Reddit comment section
         * @param eventObject The event object of the click of the Reddit button.
         * @private
         */
        private onRedditClick(eventObject: Event) {
            var googlePlusContainer, alienTubeContainer, redditButton;

            googlePlusContainer = document.getElementById("watch-discussion");
            googlePlusContainer.style.display = "none";
            alienTubeContainer = document.getElementById("alientube");
            alienTubeContainer.style.display = "block";
            redditButton = <HTMLDivElement> document.getElementById("at_switchtoreddit");
            redditButton.style.display = "none";
        }
    	
        /**
            * Switch to the Google+ comment section.
            * @param eventObject The event object of the click of the Google+ button.
            * @private
         */
        private onGooglePlusClick(eventObject: Event) {
            var googlePlusContainer, alienTubeContainer, redditButton;

            alienTubeContainer = document.getElementById("alientube");
            alienTubeContainer.style.display = "none";
            googlePlusContainer = document.getElementById("watch-discussion");
            googlePlusContainer.style.display = "block";
            redditButton = <HTMLDivElement> document.getElementById("at_switchtoreddit");
            redditButton.style.display = "block";
        }

        /**
            * Update the tabs to fit the new size of the document
            * @private
        */
        private updateTabsToFitToBoundingContainer() {
            /* Only perform the resize operation when we have a new frame to work on by the browser, any animation beyond this will not
            be rendered and is pointless. */
            window.requestAnimationFrame(() => {
                var tabContainer, overflowContainer, tabElement, currentActiveTabIndex, i, len;
                tabContainer = document.getElementById("at_tabcontainer");

                if (!tabContainer) {
                    return;
                }
                overflowContainer = <HTMLDivElement> tabContainer.querySelector("#at_overflow");

                /* Iterate over the tabs until we find the one that is currently selected, and store its value. */
                for (i = 0, len = tabContainer.children.length; i < len; i += 1) {
                    tabElement = <HTMLButtonElement> tabContainer.children[i];
                    if (tabElement.classList.contains("active")) {
                        currentActiveTabIndex = i;

                        /* Remove all tabs and overflow ites, then render them over again using new size dimensions. */
                        this.clearTabsFromTabContainer();
                        this.insertTabsIntoDocument(tabContainer, currentActiveTabIndex);
                        break;
                    }
                }
            });
        }

        /** 
            * Remove all tabs and overflow items from the DOM.
         */
        public clearTabsFromTabContainer() {
            var tabContainer, overflowContainer, childElement, overflowListElement;

            tabContainer = document.getElementById("at_tabcontainer");
            overflowContainer = <HTMLDivElement> tabContainer.querySelector("#at_overflow");

            /* Iterate over the tab elements and remove them all. Stopping short off the overflow button. */
            while (tabContainer.firstElementChild) {
                childElement = <HTMLUnknownElement> tabContainer.firstElementChild;
                if (childElement.classList.contains("at_tab")) {
                    tabContainer.removeChild(tabContainer.firstElementChild);
                } else {
                    break;
                }
            }

            /* Iterate over the overflow items, removing them all. */
            overflowListElement = <HTMLUListElement> overflowContainer.querySelector("ul");
            while (overflowListElement.firstElementChild) {
                overflowListElement.removeChild(overflowListElement.firstElementChild);
            }
        }

        /**
            * Select the new tab on click and load comment section.
            * @param eventObject the event object of the subreddit tab click.
            * @private
        */
        private onSubredditTabClick(eventObject: Event) {
            var tabElementClickedByUser, tabContainer, currentIndexOfNewTab, i, len, tabElement;
            tabElementClickedByUser = <HTMLButtonElement> eventObject.target;

            /* Only continue if the user did not click a tab that is already selected. */
            if (!tabElementClickedByUser.classList.contains("active") && tabElementClickedByUser.tagName === "BUTTON") {
                tabContainer = document.getElementById("at_tabcontainer");
                currentIndexOfNewTab = 0;

                /* Iterate over the tabs to find the currently selected one and remove its selected status */
                for (i = 0, len = tabContainer.children.length; i < len; i += 1) {
                    tabElement = <HTMLButtonElement> tabContainer.children[i];
                    if (tabElement === tabElementClickedByUser) currentIndexOfNewTab = i;
                    tabElement.classList.remove("active");
                }

                /* Mark the new tab as selected and start downloading it. */
                tabElementClickedByUser.classList.add("active");
                this.showTab(this.threadCollection[currentIndexOfNewTab]);
            }
        }

        /**
            * Create a new tab and select it when an overflow menu item is clicked, load the comment section for it as well.
            * @param eventObject the event object of the subreddit menu item click.
            * @private
        */
        private onSubredditOverflowItemClick(eventObject: Event) {
            var listOfExistingOverflowItems, i, overflowElement, threadDataForNewTab, len;

            var tabContainer = document.getElementById("at_tabcontainer");
            var overflowItemClickedByUser = <HTMLLIElement> eventObject.target;
            var currentIndexOfNewTab = 0;

            /* Iterate over the current overflow items to find the index of the one that was just clicked. */
            listOfExistingOverflowItems = <HTMLUListElement> overflowItemClickedByUser.parentNode;
            for (i = 0, len = listOfExistingOverflowItems.children.length; i < len; i += 1) {
                overflowElement = <HTMLLIElement> listOfExistingOverflowItems.children[i];
                if (overflowElement === overflowItemClickedByUser) currentIndexOfNewTab = i;
            }

            /* Derive the total index of the item in the subreddit list from the number we just calculated added
             with the total length of the visible non overflow tabs */
            currentIndexOfNewTab = (tabContainer.children.length) + currentIndexOfNewTab - 1;
            threadDataForNewTab = this.threadCollection[currentIndexOfNewTab];

            /* Move the new item frontmost in the array so it will be the first tab, and force a re-render of the tab control. */
            this.threadCollection.splice(currentIndexOfNewTab, 1);
            this.threadCollection.splice(0, 0, threadDataForNewTab);
            this.clearTabsFromTabContainer();
            this.insertTabsIntoDocument(tabContainer, 0);

            /* Start downloading the new tab. */
            this.showTab(this.threadCollection[0]);
            eventObject.stopPropagation();
        }
        
        /**
            * Triggered when the user has changed the value of the "Allow on this channel" checkbox.
            * @param eventObject the event object of the checkbox value change.
            * @private
         */
        private allowOnChannelChange(eventObject: Event) {
            var allowedOnChannel = (<HTMLInputElement>eventObject.target).checked;
            var channelId = document.querySelector("meta[itemprop='channelId']").getAttribute("content");
            var channelDisplayActions = Preferences.getObject("channelDisplayActions");
            channelDisplayActions[channelId] = allowedOnChannel ? "alientube" : "gplus";
            Preferences.set("channelDisplayActions", channelDisplayActions);
        }
        
        /**
         * Get the display action of the current channel.
         * @private
         */
        private getDisplayActionForCurrentChannel() {
            var channelId = document.querySelector("meta[itemprop='channelId']").getAttribute("content");
            var displayActionByUser = Preferences.getObject("channelDisplayActions")[channelId];
            if (displayActionByUser) {
                return displayActionByUser;
            }
            return Preferences.getString("defaultDisplayAction");
        }
        
        /**
         * Get the confidence vote of a thread using Reddit's 'hot' sorting algorithm.
         * @private
         */
        private getConfidenceForRedditThread(thread : any) : number {
            var order = Math.log(Math.max(Math.abs(thread.score), 1));
            
            var sign;
            if (thread.score > 0) {
                sign = 1;
            } else if (thread.score < 0) {
                sign = -1;
            } else {
                sign = 0;
            }
            
            var seconds = <number> Math.floor(((new Date()).getTime() / 1000) - thread.created_utc) - 1134028003;
            return Math.round((order + sign*seconds / 4500) * 10000000) / 10000000;
        }
    }
}
