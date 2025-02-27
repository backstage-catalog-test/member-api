/**
 * This service provides operations of statistics.
 */

const _ = require('lodash')
const Joi = require('joi')
const config = require('config')
const helper = require('../common/helper')
const eshelper = require('../common/eshelper')
const logger = require('../common/logger')
const errors = require('../common/errors')
const { BOOLEAN_OPERATOR } = require('../../app-constants')
const LookerApi = require('../common/LookerApi')
const moment = require('moment')

const MEMBER_FIELDS = ['userId', 'handle', 'handleLower', 'firstName', 'lastName',
  'status', 'addresses', 'photoURL', 'homeCountryCode', 'competitionCountryCode',
  'description', 'email', 'tracks', 'maxRating', 'wins', 'createdAt', 'createdBy',
  'updatedAt', 'updatedBy', 'skills', 'stats', 'emsiSkills', 'verified',
  'numberOfChallengesWon', 'numberOfChallengesPlaced']

const MEMBER_SORT_BY_FIELDS = ['userId', 'country', 'handle', 'firstName', 'lastName', 
  'numberOfChallengesWon', 'numberOfChallengesPlaced']

const MEMBER_AUTOCOMPLETE_FIELDS = ['userId', 'handle', 'handleLower',
  'status', 'email', 'createdAt', 'updatedAt']

var MEMBER_STATS_FIELDS = ['userId', 'handle', 'handleLower', 'maxRating',
  'numberOfChallengesWon', 'numberOfChallengesPlaced',
  'challenges', 'wins', 'DEVELOP', 'DESIGN', 'DATA_SCIENCE', 'COPILOT']

const esClient = helper.getESClient()
const lookerService = new LookerApi(logger)

function omitMemberAttributes (currentUser, query, allowedValues) {
  // validate and parse fields param
  let fields = helper.parseCommaSeparatedString(query.fields, allowedValues) || allowedValues
  // if current user is not admin and not M2M, then exclude the admin/M2M only fields
  if (!currentUser || (!currentUser.isMachine && !helper.hasAdminRole(currentUser))) {
    fields = _.without(fields, ...config.MEMBER_SECURE_FIELDS)
  }
  // If the current user does not have an autocompleterole, remove the communication fields
  if(!currentUser || (!currentUser.isMachine && !helper.hasAutocompleteRole(currentUser))){
    fields = _.without(fields, ...config.COMMUNICATION_SECURE_FIELDS)
  }
  return fields
}
/**
 * Search members.
 * @param {Object} currentUser the user who performs operation
 * @param {Object} query the query parameters
 * @returns {Object} the search result
 */
async function searchMembers (currentUser, query) {
  fields = omitMemberAttributes(currentUser, query, MEMBER_FIELDS)

  if (query.email != null && query.email.length > 0) {
    if (currentUser == null) {
      throw new errors.UnauthorizedError('Authentication token is required to query users by email')
    }
    if (!helper.hasSearchByEmailRole(currentUser)) {
      throw new errors.BadRequestError('Admin role is required to query users by email')
    }
  }

  if (query.email != null && query.email.length > 0) {
  if (currentUser == null) {
    throw new errors.UnauthorizedError("Authentication token is required to query users by email");
  }
  if (!helper.hasSearchByEmailRole(currentUser)) {
    throw new errors.BadRequestError("Admin role is required to query users by email");
  }
  }

  // search for the members based on query
  const docsMembers = await eshelper.getMembers(query, esClient, currentUser)

  return fillMembers(docsMembers, query, fields)
}

searchMembers.schema = {
  currentUser: Joi.any(),
  query: Joi.object().keys({
    handleLower: Joi.string(),
    handlesLower: Joi.array(),
    handle: Joi.string(),
    handles: Joi.array(),
    email: Joi.string(),
    userId: Joi.number(),
    userIds: Joi.array(),
    term: Joi.string(),
    fields: Joi.string(),
    page: Joi.page(),
    perPage: Joi.perPage(),
    sort: Joi.sort()
  })
}

async function fillMembers(docsMembers, query, fields) {
  // get the total
  const total = eshelper.getTotal(docsMembers)

  let results = []
  if (total > 0) {
    // extract member profiles from hits
    const members = _.map(docsMembers.hits.hits, (item) => item._source)

    // search for a list of members
    query.handlesLower = _.map(members, 'handleLower')

    // get skills for the members fetched
    const docsSkiills = await eshelper.getMembersSkills(query, esClient)
    // extract member skills from hits
    const mbrsSkills = _.map(docsSkiills.hits.hits, (item) => item._source)

    // get stats for the members fetched
    const docsStats = await eshelper.getMembersStats(query, esClient)
    // extract data from hits
    const mbrsSkillsStats = _.map(docsStats.hits.hits, (item) => item._source)

    // merge members profile and there skills
    const mergedMbrSkills = _.merge(_.keyBy(members, 'userId'), _.keyBy(mbrsSkills, 'userId'))
    let resultMbrSkills = _.values(mergedMbrSkills)
    resultMbrSkills = _.map(resultMbrSkills, function (item) {
      if (!item.skills) {
        item.skills = {}
      }
      return item
    })

    // merge overall members and stats
    const mbrsSkillsStatsKeys = _.keyBy(mbrsSkillsStats, 'userId')
    const resultMbrsSkillsStats = _.map(resultMbrSkills, function (item) {
      item.numberOfChallengesWon=0;
      item.numberOfChallengesPlaced=0;
      if (mbrsSkillsStatsKeys[item.userId]) {
        item.stats = []
        if (mbrsSkillsStatsKeys[item.userId].maxRating) {
          // add the maxrating
          item.maxRating = mbrsSkillsStatsKeys[item.userId].maxRating
          // set the rating color
          if (item.maxRating.hasOwnProperty('rating')) {
            item.maxRating.ratingColor = helper.getRatingColor(item.maxRating.rating)
          }
        }
        if(mbrsSkillsStatsKeys[item.userId].wins > item.numberOfChallengesWon){
          item.numberOfChallengesWon = mbrsSkillsStatsKeys[item.userId].wins
        }

        item.numberOfChallengesPlaced = mbrsSkillsStatsKeys[item.userId].challenges
        
        // clean up stats fileds and filter on stats fields
        item.stats.push(_.pick(mbrsSkillsStatsKeys[item.userId], MEMBER_STATS_FIELDS))
      } else {
        item.stats = []
      }
      return item
    })

    
    // sort the data
    results = _.orderBy(resultMbrsSkillsStats, [query.sortBy, "handleLower"], [query.sortOrder] )

    // Get the verification data from Looker
    for (let i = 0; i < results.length; i += 1) {
      if(await lookerService.isMemberVerified(results[i].userId)){
        results[i].verified = true
      }
      else{
        results[i].verified = false
      }
    }
    // filter member based on fields
    results = _.map(results, (item) => _.pick(item, fields))
  }

  results = helper.paginate(results, query.perPage, query.page - 1)
  // filter member based on fields
  

  return { total: total, page: query.page, perPage: query.perPage, result: results }
}

// TODO - use some caching approach to replace these in-memory objects
/**
 * Search members by the given search query
 *
 * @param query The search query by which to search members
 *
 * @returns {Promise<[]>} The array of members matching the given query
 */
const searchMembersBySkills = async (currentUser, query) => {
  const esClient = await helper.getESClient()
  let skillIds = await helper.getParamsFromQueryAsArray(query, 'skillId')
  const result = searchMembersBySkillsWithOptions(currentUser, query, skillIds, BOOLEAN_OPERATOR.AND, query.page, query.perPage, query.sortBy, query.sortOrder, esClient)
  return result
}

searchMembersBySkills.schema = {
  currentUser: Joi.any(),
  query: Joi.object().keys({
    skillId: Joi.alternatives().try(Joi.string(), Joi.array().items(Joi.string())),
    page: Joi.page(),
    perPage: Joi.perPage(),
    sortBy: Joi.string().valid(MEMBER_SORT_BY_FIELDS).default('numberOfChallengesWon'),
    sortOrder: Joi.string().valid('asc', 'desc').default('desc')
  })
}

/**
 * Search members matching the given skills
 *
 * @param currentUser
 * @param skillsFilter
 * @param skillsBooleanOperator
 * @param page
 * @param perPage
 * @param sortBy
 * @param sortOrder
 * @param esClient
 * @returns {Promise<*[]|{total, perPage, numberOfPages: number, data: *[], page}>}
 */
const searchMembersBySkillsWithOptions = async (currentUser, query, skillsFilter, skillsBooleanOperator, page, perPage, sortBy, sortOrder, esClient) => {
  fields = omitMemberAttributes(currentUser, query, MEMBER_FIELDS)
  const emptyResult = {
    total: 0,
    page,
    perPage,
    numberOfPages: 0,
    data: []
  }
  if (_.isEmpty(skillsFilter)) {
    return emptyResult
  }

  const membersSkillsDocs = await eshelper.searchMembersSkills(skillsFilter, skillsBooleanOperator, page, perPage, esClient)
  
  let response = await fillMembers(membersSkillsDocs, query, fields)
  response.result = _.orderBy(response.result, sortBy, sortOrder)
  return response
}
/**
 * members autocomplete.
 * @param {Object} currentUser the user who performs operation
 * @param {Object} query the query parameters
 * @returns {Object} the autocomplete result
 */
async function autocomplete (currentUser, query) {
  fields = omitMemberAttributes(currentUser, query, MEMBER_AUTOCOMPLETE_FIELDS)

  // get suggestion based on querys term
  const docsSuggestions = await eshelper.getSuggestion(query, esClient, currentUser)
  if (docsSuggestions.hasOwnProperty('suggest')) {
    const totalSuggest = docsSuggestions.suggest['handle-suggestion'][0].options.length
    var results = docsSuggestions.suggest['handle-suggestion'][0].options
    // custom filter & sort
    let regex = new RegExp(`^${query.term}`, `i`)
    // sometimes .payload is not defined. so use _source instead
    results = results.map(x => ({ ...x, payload: x.payload || x._source }))
    results = results
      .filter(x => regex.test(x.payload.handle))
      .sort((a, b) => a.payload.handle.localeCompare(b.payload.handle))
    // filter member based on fields
    results = _.map(results, (item) => _.pick(item.payload, fields))
    // custom pagination
    results = helper.paginate(results, query.perPage, query.page - 1)
    return { total: totalSuggest, page: query.page, perPage: query.perPage, result: results }
  }
  return { total: 0, page: query.page, perPage: query.perPage, result: [] }
}

autocomplete.schema = {
  currentUser: Joi.any(),
  query: Joi.object().keys({
    term: Joi.string(),
    fields: Joi.string(),
    page: Joi.page(),
    perPage: Joi.perPage(),
    size: Joi.size(),
    sortOrder: Joi.string().valid('asc', 'desc').default('desc')
  })
}

module.exports = {
  searchMembers,
  searchMembersBySkills,
  autocomplete
}

logger.buildService(module.exports)
